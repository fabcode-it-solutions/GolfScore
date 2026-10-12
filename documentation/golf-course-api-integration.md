# Golf Course API Integration Feature Plan

**Status**: Approved & Ready for Implementation  
**Date Created**: 2026-06-29  
**Branch**: feature/GolfCourseAPI

---

## Overview

Currently, users must manually enter golf course information (name, location, par, handicap) every time they start a new round. This feature adds the ability to search for golf courses via the Golf Course API and import them into the app, reducing manual data entry and API quota usage by caching courses locally in the database.

### Key Constraints
- **API Limit**: 50 calls per day (tracked internally, not shown to users)
- **API Key**: Must be stored securely in Supabase secrets/vault
- **Data Extracted**: Hole number, par, handicap only (ignore tees/yardage)
- **Tech Stack**: Vanilla JS frontend + Supabase backend (no custom server)
- **Solution**: Supabase Edge Functions as secure API proxy

---

## User Requirements (Clarified)

- Users can search for courses via autocomplete input
- Search results show locally-saved courses first, then API results
- Users can import courses from the API; only imported courses are saved to DB
- API key is stored securely (Supabase secrets) and never exposed to frontend
- API usage is tracked internally but NOT shown to end users
- When API limit is reached, search gracefully degrades to local DB only (silent fail)
- Feature integrates with existing feature/LockIn branch

---

## Implementation Phases

### Phase 1: Database Schema & Infrastructure Setup

These tasks establish the foundation for secure API access and usage tracking.

#### Task 1.1: Create `api_usage` table in Supabase schema
**File**: `supabase_schema.sql`

Add a new table to track API calls per user per day:

```sql
CREATE TABLE api_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  call_count INT NOT NULL DEFAULT 0,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, date)
);

CREATE INDEX idx_api_usage_user_date ON api_usage(user_id, date);
```

**Why**: Tracks daily API calls per user to enforce the 50-call limit. Unique constraint ensures one row per user per day.

**Verification**: Confirm table exists in Supabase; verify indexes are created.

---

#### Task 1.2: Modify `courses` table schema
**File**: `supabase_schema.sql`

Add columns to track the source of the course (manual vs. API imported):

```sql
ALTER TABLE courses ADD COLUMN source TEXT DEFAULT 'manual' CHECK (source IN ('manual', 'api'));
ALTER TABLE courses ADD COLUMN external_id TEXT UNIQUE; -- Golf Course API ID (opaque string)
ALTER TABLE courses ADD COLUMN api_club_name TEXT;
ALTER TABLE courses ADD COLUMN api_location JSONB; -- Full location data from API
```

**Why**: 
- `source` identifies whether course was entered manually or imported from API
- `external_id` prevents duplicate imports and allows future syncs with API data
- `api_club_name` and `api_location` preserve the original API data for reference

**Verification**: Confirm new columns exist on `courses` table; verify `external_id` unique constraint works.

---

#### Task 1.3: Store Golf Course API key in Supabase secrets (Partner Task)
**Owner**: Partner with Supabase access  
**Action**: Store the Golf Course API key in Supabase vault/secrets

The API key should be stored as a Supabase secret (e.g., `GOLF_COURSE_API_KEY`). This is NOT accessed from frontend code; it's only available to Edge Functions.

**Verification**: Confirm the secret is accessible in Supabase Edge Function context.

---

#### Task 1.4: Create Edge Function `search-golf-course` (Partner Task)
**Owner**: Partner with Supabase access  
**Location**: Supabase Dashboard > Edge Functions > Create `search-golf-course`

This function acts as a secure proxy for Golf Course API search requests:

```typescript
// Pseudo-code structure
export default async (req: Request) => {
  const { searchQuery, userId } = await req.json();
  
  // Check API usage limit
  const usage = await checkApiUsage(userId);
  if (usage.call_count >= 50) {
    return new Response(JSON.stringify({ error: "API limit reached" }), { status: 429 });
  }
  
  // Call Golf Course API
  const apiKey = Deno.env.get('GOLF_COURSE_API_KEY');
  const response = await fetch(`https://api.golfcourseapi.com/v1/search?search_query=${searchQuery}`, {
    headers: { 'Authorization': `Key ${apiKey}` }
  });
  
  const data = await response.json();
  
  // Increment usage counter
  await incrementApiUsage(userId);
  
  // Return only needed fields
  return new Response(JSON.stringify({
    results: data.courses.map(course => ({
      id: course.id,
      club_name: course.club_name,
      course_name: course.course_name,
      location: course.location
    }))
  }));
};
```

**Expected Request**: 
```json
{ "searchQuery": "Pebble Beach", "userId": "user-uuid" }
```

**Expected Response**:
```json
{
  "results": [
    { "id": 123, "club_name": "Pebble Beach Golf Links", "course_name": "Pebble Beach", "location": {...} },
    ...
  ]
}
```

**Verification**: Test with a known course; confirm API calls are counted in `api_usage` table.

---

#### Task 1.5: Create Edge Function `get-golf-course` (Partner Task)
**Owner**: Partner with Supabase access  
**Location**: Supabase Dashboard > Edge Functions > Create `get-golf-course`

This function fetches full course details and extracts only relevant hole/par/handicap info:

```typescript
// Pseudo-code structure
export default async (req: Request) => {
  const { courseId, userId } = await req.json();
  
  // Check API usage limit
  const usage = await checkApiUsage(userId);
  if (usage.call_count >= 50) {
    return new Response(JSON.stringify({ error: "API limit reached" }), { status: 429 });
  }
  
  // Call Golf Course API
  const apiKey = Deno.env.get('GOLF_COURSE_API_KEY');
  const response = await fetch(`https://api.golfcourseapi.com/v1/courses/${courseId}`, {
    headers: { 'Authorization': `Key ${apiKey}` }
  });
  
  const data = await response.json();
  
  // Extract holes from first available tee (e.g., 'male' or 'female')
  const teeType = Object.keys(data.tees)[0]; // Get first tee type
  const holeData = data.tees[teeType][0].holes; // Get first course/tee combo
  
  // Increment usage counter
  await incrementApiUsage(userId);
  
  // Transform to match local schema (hole number, par, handicap)
  return new Response(JSON.stringify({
    id: data.id,
    club_name: data.club_name,
    course_name: data.course_name,
    location: data.location,
    pars: holeData.map(h => h.par),
    handicaps: holeData.map(h => h.handicap),
    hole_count: holeData.length
  }));
};
```

**Expected Request**: 
```json
{ "courseId": 123, "userId": "user-uuid" }
```

**Expected Response**:
```json
{
  "id": 123,
  "club_name": "Pebble Beach Golf Links",
  "course_name": "Pebble Beach",
  "location": {...},
  "pars": [4, 5, 4, 4, 3, 5, 3, 4, 4, 5, 4, 3, 4, 5, 3, 4, 4, 5],
  "handicaps": [1, 15, 7, 9, 17, 3, 13, 5, 11, 2, 14, 18, 8, 4, 16, 6, 10, 12],
  "hole_count": 18
}
```

**Verification**: Test with a known course ID; confirm pars/handicaps match expected values; confirm no tees/yardage data is returned.

---

### Phase 2: Frontend - Autocomplete Search UI

These tasks add the search interface and wiring to the course upload form.

#### Task 2.1: Modify HTML form for course search (index.html)
**File**: `index.html`

In the `screen-course-upload` section, replace or enhance the course name input with a searchable autocomplete:

**Current State**: Look for the course name input around line 160+

**Changes**:
1. Replace the simple text input with an autocomplete wrapper
2. Add a search input with debounce capability
3. Add a dropdown container to display search results

**Example HTML**:
```html
<!-- Replace the existing course name input with: -->
<div class="form-group">
  <label for="course-search">Course Name <span class="required">*</span></label>
  <div class="course-search-wrapper">
    <input 
      type="text" 
      id="course-search" 
      placeholder="Search for a course..." 
      autocomplete="off"
    >
    <div id="course-search-results" class="search-results-dropdown" style="display: none;">
      <!-- Results populated dynamically via JavaScript -->
    </div>
  </div>
</div>
```

**Styling Needed**: Add CSS for `.course-search-wrapper` and `.search-results-dropdown` to position dropdown below input.

**Verification**: Open course upload screen; verify search input is visible and dropdown appears when clicking.

---

#### Task 2.2: Add CSS for autocomplete styling (assets/styles.css)
**File**: `assets/styles.css`

Add styling for the search autocomplete dropdown:

```css
.course-search-wrapper {
  position: relative;
  width: 100%;
}

.course-search-wrapper input {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 14px;
}

.search-results-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  background: white;
  border: 1px solid #ddd;
  border-top: none;
  border-radius: 0 0 4px 4px;
  max-height: 300px;
  overflow-y: auto;
  z-index: 1000;
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}

.search-result-item {
  padding: 10px 12px;
  border-bottom: 1px solid #f0f0f0;
  cursor: pointer;
}

.search-result-item:hover {
  background-color: #f5f5f5;
}

.search-result-item.local {
  font-weight: 500;
  border-left: 3px solid #4CAF50;
  padding-left: 9px;
}

.search-result-item.api {
  color: #666;
  border-left: 3px solid #2196F3;
  padding-left: 9px;
}

.search-result-label {
  font-size: 12px;
  color: #999;
  margin-left: 8px;
}
```

**Verification**: Check that dropdown styling looks clean; verify local results have green border and API results have blue border.

---

#### Task 2.3: Implement `searchCourses()` function (assets/courses.js)
**File**: `assets/courses.js`

Add a new function to search both local DB and API:

```javascript
// Add this function to courses.js
let searchDebounceTimer;

async function searchCourses(query) {
  if (!query || query.trim().length < 2) {
    hideSearchResults();
    return;
  }

  // Search local courses
  const localResults = await searchLocalCourses(query);
  
  // If fewer than 5 local results, search API
  let apiResults = [];
  if (localResults.length < 5) {
    apiResults = await searchApiCourses(query);
  }

  // Display combined results
  displaySearchResults(localResults, apiResults);
}

async function searchLocalCourses(query) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabaseClient
    .from('courses')
    .select('*')
    .or(`name.ilike.%${query}%,location.ilike.%${query}%`)
    .eq('user_id', user.id)
    .order('name', { ascending: true })
    .limit(10);

  return data || [];
}

async function searchApiCourses(query) {
  try {
    const { data: { user } } = await supabaseClient.auth.getUser();
    
    // Call Edge Function as secure proxy
    const { data, error } = await supabaseClient.functions.invoke('search-golf-course', {
      body: { searchQuery: query, userId: user.id }
    });

    if (error || data.error) {
      console.warn('API search unavailable');
      return [];
    }

    // Transform API results to match local format
    return (data.results || []).map(course => ({
      id: course.id,
      name: course.course_name,
      location: course.location.city + ', ' + course.location.state,
      club_name: course.club_name,
      source: 'api',
      external_id: course.id
    }));
  } catch (err) {
    console.error('API search failed:', err);
    return [];
  }
}

function displaySearchResults(localResults, apiResults) {
  const dropdown = document.getElementById('course-search-results');
  dropdown.innerHTML = '';

  // Display local results
  if (localResults.length > 0) {
    const localLabel = document.createElement('div');
    localLabel.className = 'search-result-label';
    localLabel.textContent = 'YOUR COURSES';
    dropdown.appendChild(localLabel);

    localResults.forEach(course => {
      const item = document.createElement('div');
      item.className = 'search-result-item local';
      item.textContent = `${course.name} - ${course.location}`;
      item.onclick = () => selectCourse(course);
      dropdown.appendChild(item);
    });
  }

  // Display API results
  if (apiResults.length > 0) {
    if (localResults.length > 0) {
      const divider = document.createElement('div');
      divider.style.height = '1px';
      divider.style.backgroundColor = '#eee';
      divider.style.margin = '4px 0';
      dropdown.appendChild(divider);
    }

    const apiLabel = document.createElement('div');
    apiLabel.className = 'search-result-label';
    apiLabel.textContent = 'GOLF COURSE API';
    dropdown.appendChild(apiLabel);

    apiResults.forEach(course => {
      const item = document.createElement('div');
      item.className = 'search-result-item api';
      item.textContent = `${course.name} - ${course.location}`;
      item.onclick = () => selectCourse(course);
      dropdown.appendChild(item);
    });
  }

  dropdown.style.display = 'block';
}

function hideSearchResults() {
  const dropdown = document.getElementById('course-search-results');
  dropdown.style.display = 'none';
}
```

**Verification**: Type in search box; confirm local courses appear first, then API results below; verify results update as you type.

---

#### Task 2.4: Add search input event listener (assets/courses.js)
**File**: `assets/courses.js`

Wire up the search input to trigger the search function with debounce:

```javascript
// Add to the initialization/setup section of courses.js
function initializeCourseSearch() {
  const searchInput = document.getElementById('course-search');
  if (!searchInput) return;

  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      searchCourses(e.target.value);
    }, 300); // Wait 300ms after user stops typing
  });

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.course-search-wrapper')) {
      hideSearchResults();
    }
  });
}

// Call this on page load
document.addEventListener('DOMContentLoaded', () => {
  initializeCourseSearch();
  // ... other initialization code
});
```

**Verification**: Type in search box; verify dropdown appears after 300ms; click outside; verify dropdown closes.

---

### Phase 3: Course Selection & Import Logic

These tasks handle what happens when a user selects a course (local vs. API).

#### Task 3.1: Implement `selectCourse()` handler (assets/courses.js)
**File**: `assets/courses.js`

Add function to handle course selection:

```javascript
async function selectCourse(course) {
  hideSearchResults();

  if (course.source === 'api') {
    // Import from API: fetch full details
    await importApiCourse(course);
  } else {
    // Use local course: populate form
    populateFormWithCourse(course);
  }
}

async function importApiCourse(course) {
  try {
    // Show loading state
    const searchInput = document.getElementById('course-search');
    searchInput.disabled = true;
    const originalText = searchInput.value;
    searchInput.value = 'Loading course details...';

    const { data: { user } } = await supabaseClient.auth.getUser();

    // Call Edge Function to get full course details
    const { data, error } = await supabaseClient.functions.invoke('get-golf-course', {
      body: { courseId: course.external_id, userId: user.id }
    });

    if (error || data.error) {
      alert('Failed to import course. Please try again.');
      searchInput.disabled = false;
      searchInput.value = originalText;
      return;
    }

    // Populate form with imported data
    document.getElementById('course-name').value = data.course_name;
    document.getElementById('course-location').value = data.location.city + ', ' + data.location.state;
    
    // Set hole count selector and regenerate grid
    const holeSelect = document.getElementById('hole-count');
    holeSelect.value = data.hole_count;
    holeSelect.dispatchEvent(new Event('change'));

    // Wait a tick for grid to be created, then populate
    await new Promise(resolve => setTimeout(resolve, 100));

    // Fill in pars
    const parInputs = document.querySelectorAll('.par-input');
    data.pars.forEach((par, index) => {
      if (parInputs[index]) {
        parInputs[index].value = par;
        parInputs[index].dispatchEvent(new Event('change'));
      }
    });

    // Fill in handicaps
    const handicapInputs = document.querySelectorAll('.handicap-input');
    data.handicaps.forEach((handicap, index) => {
      if (handicapInputs[index]) {
        handicapInputs[index].value = handicap;
        handicapInputs[index].dispatchEvent(new Event('change'));
      }
    });

    // Store API source info for save
    window.currentCourseImport = {
      source: 'api',
      external_id: course.external_id,
      api_club_name: data.club_name,
      api_location: data.location
    };

    // Reset search
    searchInput.disabled = false;
    searchInput.value = '';
  } catch (err) {
    console.error('Failed to import course:', err);
    alert('Failed to import course. Please try again.');
  }
}

function populateFormWithCourse(course) {
  document.getElementById('course-name').value = course.name;
  document.getElementById('course-location').value = course.location;
  
  // Load full course data and populate grids
  // (existing logic for loading local courses)
  
  window.currentCourseImport = null;
}
```

**Verification**: Select a local course; verify form populates; select an API course; verify all par/handicap values fill in correctly.

---

#### Task 3.2: Update `saveCourseCore()` to handle API imports (assets/courses.js)
**File**: `assets/courses.js`

Modify the existing `saveCourseCore()` function to include API source information:

**Current behavior to preserve**: Validation logic, duplicate checking, user_id capture

**New behavior to add**: When saving, check if `window.currentCourseImport` is set (indicating an API import) and include those fields:

```javascript
// Find the saveCourseCore() function and modify the insert payload:

async function saveCourseCore(courseName, courseLocation, holeCount, pars, strokeIndex) {
  // ... existing validation code ...

  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) {
    alert('You must be logged in to save a course.');
    return;
  }

  // Build the course object
  const courseData = {
    user_id: user.id,
    name: courseName,
    location: courseLocation,
    hole_count: holeCount,
    pars: pars,
    stroke_index: strokeIndex,
    source: window.currentCourseImport?.source || 'manual',
    external_id: window.currentCourseImport?.external_id || null,
    api_club_name: window.currentCourseImport?.api_club_name || null,
    api_location: window.currentCourseImport?.api_location || null
  };

  // ... rest of insert/update logic remains the same ...
  
  // Clear the import context after save
  window.currentCourseImport = null;
}
```

**Verification**: Save a manually-entered course; verify `source='manual'` and `external_id=null` in DB. Save an API-imported course; verify `source='api'` and `external_id` is populated.

---

### Phase 4: Testing & Validation

These tasks verify the complete feature works end-to-end.

#### Task 4.1: Test local course search
**Manual Test**:
1. Save a local course called "Pebble Beach"
2. Go to upload course screen
3. Type "Pebble" in search
4. Verify the course appears within 100ms with green border label "YOUR COURSES"

**Expected**: Local course appears immediately

---

#### Task 4.2: Test API course search (under limit)
**Manual Test**:
1. Make sure API call count is below 50 for today
2. Go to upload course screen
3. Type a course name NOT in your saved courses (e.g., "Augusta National")
4. Wait 1-2 seconds
5. Verify results appear with blue border label "GOLF COURSE API"
6. Check Supabase `api_usage` table; verify `call_count` incremented by 1

**Expected**: API results appear; usage counter increments

---

#### Task 4.3: Test API course import
**Manual Test**:
1. Search for an API course
2. Click on an API result
3. Verify form populates with:
   - Course name
   - Location
   - 18 (or 9) holes
   - Par values for each hole
   - Handicap rankings for each hole
4. Verify no tees or yardage data is shown
5. Save the course
6. Verify course appears in `courses` table with `source='api'` and `external_id` populated

**Expected**: Form fills completely with correct data; course saves with API metadata

---

#### Task 4.4: Test deduplication on re-import
**Manual Test**:
1. Search for the same API course again
2. Verify it appears in "YOUR COURSES" section (not API section)
3. Click it
4. Verify form populates from local DB (no API call made)
5. Check `api_usage` table; verify `call_count` did NOT increment

**Expected**: Course reuses local DB; no API call made

---

#### Task 4.5: Test rate limiting (50 call limit)
**Manual Test** *(or simulate with database manipulation)*:
1. Set `api_usage` table for current user/date to `call_count = 49`
2. Perform 1 API search → should succeed (50th call)
3. Check `api_usage` → should show `call_count = 50`
4. Perform another API search → should fail silently
5. Verify dropdown shows only local courses (no API results, no error message)

**Expected**: After 50 calls, API search returns no results without error message to user

---

#### Task 4.6: Test API limit reset next day
**Manual Test** *(or simulate)*:
1. From previous test, API usage for today is at 50
2. Manipulate `api_usage` row to change `date` to tomorrow
3. Or wait until next calendar day
4. Perform an API search
5. Verify it succeeds (new day, counter reset)
6. Verify new row created in `api_usage` with today's date and `call_count = 1`

**Expected**: New day starts with fresh 50-call quota

---

### Dependencies & Prerequisites

**Must complete before implementation**:
- [x] User clarifications gathered (autocomplete, API storage, rate limiting)
- [x] Codebase exploration completed (current architecture understood)
- [ ] Partner sets up Supabase secrets with Golf Course API key
- [ ] Partner creates Edge Functions (`search-golf-course` and `get-golf-course`)
- [ ] Database migrations applied (new tables and columns)

**Implementation order** *(tasks should be done in order within each phase, but phases 1-2 can overlap)*:

1. Phase 1: Database (Tasks 1.1-1.2) — can happen in parallel with 1.3-1.5
2. Partner completes 1.3-1.5 (Edge Functions setup)
3. Phase 2: Frontend UI (Tasks 2.1-2.4) — can start while partner sets up Edge Functions
4. Phase 3: Logic (Tasks 3.1-3.2) — depends on Phase 2 completion
5. Phase 4: Testing — final validation once Phase 3 complete

---

## File Summary

### Files to Modify
- `supabase_schema.sql` — Add `api_usage` table; modify `courses` table
- `index.html` — Add search autocomplete input and dropdown
- `assets/styles.css` — Add CSS for autocomplete styling
- `assets/courses.js` — Add `searchCourses()`, `searchApiCourses()`, `selectCourse()`, `importApiCourse()`, modify `saveCourseCore()`

### Files to Create (by partner)
- Supabase Edge Function: `search-golf-course`
- Supabase Edge Function: `get-golf-course`
- Supabase Secret: `GOLF_COURSE_API_KEY`

### No Changes Needed
- `index.html` form sections other than course search input
- `assets/auth.js`, `assets/supabase-config.js` (no changes required)
- Test files (can be added separately)

---

## Notes & Considerations

1. **Daily Reset Logic**: The current plan assumes `api_usage` is tracked with a `date` column that auto-resets based on CURRENT_DATE. If manual reset is needed, the Edge Functions should handle that logic.

2. **Partial Course Data**: If an API course has incomplete data (missing pars or handicaps for any hole), the Edge Function should validate and reject it, returning an error to the frontend.

3. **User Feedback**: When API search fails (limit reached or API down), the frontend silently shows only local results. Consider adding subtle logging for debugging purposes.

4. **Future Enhancements**:
   - Sync existing saved courses with API updates (check if course details changed)
   - Allow users to view/edit API metadata after import
   - Add analytics on which courses are most frequently imported vs. manually entered

---

## Rollback Plan

If the feature needs to be reverted:
1. Remove `source`, `external_id`, `api_club_name`, `api_location` columns from `courses` table
2. Remove `api_usage` table
3. Revert changes to `index.html`, `assets/styles.css`, `assets/courses.js`
4. Delete Edge Functions (or disable them in Supabase)

The app will revert to manual course entry workflow with no breaking changes.
