'use strict';

/* ===========================================================
   courses.js — saved course library: the upload/builder screen,
   and loading a user's saved courses for the round setup screen.
   Depends on: core.js (state, escapeHtml/escapeAttr, showToast, showScreen)
=========================================================== */

function renderCourseHoleGrid() {
  const holeCount = Number(document.getElementById('course-hole-count').value);
  const grid = document.getElementById('course-hole-grid');
  grid.innerHTML = '';
  for (let h = 1; h <= holeCount; h++) {
    const cell = document.createElement('div');
    cell.className = 'course-hole-cell';
    cell.innerHTML = `
      <span class="course-hole-label">Hole ${h}</span>
      <input type="number" class="course-par-input" data-hole="${h}" min="2" max="6" placeholder="Par" inputmode="numeric">
      <input type="number" class="course-hcp-input" data-hole="${h}" min="1" max="${holeCount}" placeholder="HCP" inputmode="numeric">
    `;
    grid.appendChild(cell);
  }
  grid.querySelectorAll('.course-par-input, .course-hcp-input').forEach(inp => {
    inp.addEventListener('input', updateStartRoundButtonState);
  });
  updateStartRoundButtonState();
}

// Enables "Save & start a round" only once every hole has both a par
// and a handicap ranking entered. Name, location, range, and duplicate
// checks still happen on click — same as the regular Save button.
function updateStartRoundButtonState() {
  const pars = document.querySelectorAll('.course-par-input');
  const hcps = document.querySelectorAll('.course-hcp-input');
  const allFilled = pars.length > 0 &&
    Array.from(pars).every(inp => inp.value !== '') &&
    Array.from(hcps).every(inp => inp.value !== '');
  document.getElementById('btn-save-course-start-round').disabled = !allFilled;
}

// Looks up a course already cached locally by its Golf Course API id, so
// we can skip re-fetching full hole details (get-golf-course) for a
// course that's already been imported — by this user or anyone else,
// since courses are a shared library.
async function findCachedApiCourse(externalId) {
  if (!externalId) return null;
  const { data, error } = await supabaseClient
    .from('courses')
    .select('*')
    .eq('external_id', externalId)
    .maybeSingle();
  if (error) {
    console.error(error);
    return null;
  }
  return data || null;
}

// Drops API search results we've already cached locally (matched by
// external_id), so an already-imported course doesn't show up twice —
// once under "SAVED COURSES" and again under "GOLF COURSE API".
function filterCachedApiResults(apiResults, localResults) {
  const cachedIds = new Set(
    localResults.filter(c => c.external_id != null).map(c => String(c.external_id))
  );
  return apiResults.filter(c => !cachedIds.has(String(c.external_id)));
}

function initializeCourseSearch() {
  const searchInput = document.getElementById('course-search');
  const resultsEl = document.getElementById('course-search-results');
  if (!searchInput || !resultsEl) return;

  const runCourseSearch = () => searchCourses(searchInput.value);

  const searchBtn = document.getElementById('btn-course-search');
  if (searchBtn) searchBtn.addEventListener('click', runCourseSearch);

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runCourseSearch();
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.course-search-wrapper')) {
      hideCourseSearchResults();
    }
  });
}

async function searchCourses(query) {
  const trimmed = query.trim();
  if (trimmed.length < 2) {
    hideCourseSearchResults();
    return;
  }

  const localResults = await searchLocalCourses(trimmed);
  let apiResults = [];
  if (localResults.length < 5) {
    apiResults = filterCachedApiResults(await searchApiCourses(trimmed), localResults);
  }
  displayCourseSearchResults(localResults, apiResults);
}

// Searches the shared course library. Every course is visible to every
// user here regardless of who made it or how (manual entry, API import,
// or anything added later) — ownership only matters for edit/delete,
// which is enforced separately (see startEditingCourse / deleteCourse
// and the courses RLS policies), not for search visibility.
async function searchLocalCourses(query) {
  const search = query.trim();

  const { data, error } = await supabaseClient
    .from('courses')
    .select('*')
    .or(`name.ilike.%${search}%,location.ilike.%${search}%`)
    .order('name', { ascending: true })
    .limit(25);

  if (error) {
    console.error(error);
    return [];
  }

  return data || [];
}

async function searchApiCourses(query) {
  try {
    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) return [];

    const { data, error } = await supabaseClient.functions.invoke('search-golf-course', {
      body: { searchQuery: query, userId: user.id }
    });

    if (error || data?.error) {
      return [];
    }

    return (data?.results || []).map(course => ({
      ...course,
      source: 'api',
      external_id: course.id,
      name: course.course_name || course.club_name,
      location: course.location_text || course.location?.city || course.location?.state || ''
    }));
  } catch (err) {
    console.error('API search failed', err);
    return [];
  }
}

function displayCourseSearchResults(localResults, apiResults) {
  const resultsEl = document.getElementById('course-search-results');
  if (!resultsEl) return;

  resultsEl.innerHTML = '';

  const combined = [
    ...localResults.map(course => ({ ...course, source: 'local' })),
    ...apiResults
  ];

  if (combined.length === 0) {
    resultsEl.innerHTML = '<div class="search-result-empty">No matches found</div>';
    resultsEl.hidden = false;
    return;
  }

  combined.forEach(item => {
    const row = document.createElement('div');
    row.className = 'search-result-item';
    row.textContent = `${item.name || item.course_name || 'Course'}${item.location ? ` - ${item.location}` : ''}`;
    row.addEventListener('click', () => selectCourseFromSearch(item));
    resultsEl.appendChild(row);
  });

  resultsEl.hidden = false;
}

function hideCourseSearchResults() {
  const resultsEl = document.getElementById('course-search-results');
  if (resultsEl) {
    resultsEl.hidden = true;
    resultsEl.innerHTML = '';
  }
}

async function selectCourseFromSearch(course) {
  hideCourseSearchResults();
  if (!course) return;

  if (course.source === 'api') {
    await importApiCourse(course);
  } else {
    populateFormWithCourse(course);
  }
}

function populateFormWithCourse(course) {
  document.getElementById('course-upload-name').value = course.name || '';
  document.getElementById('course-upload-location').value = course.location || '';
  document.getElementById('course-hole-count').value = String(course.hole_count || '18');
  renderCourseHoleGrid();

  const pars = Array.isArray(course.pars) ? course.pars : [];
  const strokeIndex = Array.isArray(course.stroke_index) ? course.stroke_index : [];

  document.querySelectorAll('.course-par-input').forEach((inp, index) => {
    inp.value = pars[index] ?? '';
  });
  document.querySelectorAll('.course-hcp-input').forEach((inp, index) => {
    inp.value = strokeIndex[index] ?? '';
  });

  state.editingCourseId = course.id;
  document.getElementById('course-upload-heading').textContent = 'Edit course';
  document.getElementById('btn-save-course').textContent = 'Save changes';
  document.getElementById('course-search').value = '';
  window.currentCourseImport = null;
  updateStartRoundButtonState();
}

async function importApiCourse(course) {
  try {
    const searchInput = document.getElementById('course-search');
    const originalValue = searchInput?.value || '';

    // Already imported by someone — reuse it instead of burning another
    // get-golf-course call.
    const cached = await findCachedApiCourse(course.external_id);
    if (cached) {
      hideCourseSearchResults();
      if (searchInput) searchInput.value = '';
      state.myCourses = [
        ...(state.myCourses || []).filter(c => c.id !== cached.id),
        cached
      ];
      populateFormWithCourse(cached);
      return;
    }

    if (searchInput) {
      searchInput.disabled = true;
      searchInput.value = 'Loading course details...';
    }

    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) {
      showToast('You need to be logged in to import a course');
      if (searchInput) {
        searchInput.disabled = false;
        searchInput.value = originalValue;
      }
      return;
    }

    const { data, error } = await supabaseClient.functions.invoke('get-golf-course', {
      body: { courseId: course.external_id, userId: user.id }
    });

    if (error || data?.error) {
      console.error(error || data?.error);
      showToast('Could not import that course right now');
      if (searchInput) {
        searchInput.disabled = false;
        searchInput.value = originalValue;
      }
      return;
    }

    document.getElementById('course-upload-name').value = data.course_name || course.name || '';
    document.getElementById('course-upload-location').value = data.location?.city && data.location?.state
      ? `${data.location.city}, ${data.location.state}`
      : data.location?.city || data.location?.state || '';

    document.getElementById('course-hole-count').value = String(data.hole_count || 18);
    renderCourseHoleGrid();

    // courses.js — importApiCourse
    const holes = Array.isArray(data.holes) ? data.holes : [];
    const pars = holes.map(h => h.par);
    const strokeIndex = holes.map(h => h.handicap);

    document.querySelectorAll('.course-par-input').forEach((inp, index) => {
      inp.value = pars[index] ?? '';
    });
    document.querySelectorAll('.course-hcp-input').forEach((inp, index) => {
      inp.value = strokeIndex[index] ?? '';
    });

    state.editingCourseId = null;
    document.getElementById('course-upload-heading').textContent = 'Upload a course';
    document.getElementById('btn-save-course').textContent = 'Save course';
    window.currentCourseImport = {
      source: 'api',
      external_id: course.external_id,
      api_club_name: data.club_name,
      api_location: data.location
    };

    updateStartRoundButtonState();
    if (searchInput) {
      searchInput.disabled = false;
      searchInput.value = '';
    }
  } catch (err) {
    console.error('Failed to import course', err);
    showToast('Could not import that course right now');
  }
}

async function resetCourseUploadScreen() {
  state.editingCourseId = null;
  document.getElementById('course-upload-heading').textContent = 'Upload a course';
  document.getElementById('btn-save-course').textContent = 'Save course';
  document.getElementById('course-upload-name').value = '';
  document.getElementById('course-upload-location').value = '';
  document.getElementById('course-search').value = '';
  document.getElementById('course-hole-count').value = '18';
  hideCourseSearchResults();
  window.currentCourseImport = null;
  renderCourseHoleGrid();
  // Load the current course list now so saveCourse() can check for
  // duplicates locally without an extra round-trip at save time.
  state.myCourses = await loadMyCourses();
}

// Pre-fills the upload screen with an existing course's data and
// switches it into "edit" mode, so saveCourse() updates that row
// instead of inserting a new one.
async function startEditingCourse(courseId) {
  state.myCourses = await loadMyCourses();
  const course = state.myCourses.find(c => c.id === courseId);
  if (!course) {
    showToast('Could not find that course');
    return;
  }

  state.editingCourseId = course.id;
  document.getElementById('course-upload-heading').textContent = 'Edit course';
  document.getElementById('btn-save-course').textContent = 'Save changes';
  document.getElementById('course-upload-name').value = course.name;
  document.getElementById('course-upload-location').value = course.location;
  document.getElementById('course-hole-count').value = String(course.hole_count);
  renderCourseHoleGrid();
  document.querySelectorAll('.course-par-input').forEach(inp => {
    const h = Number(inp.dataset.hole) - 1;
    inp.value = course.pars[h];
  });
  document.querySelectorAll('.course-hcp-input').forEach(inp => {
    const h = Number(inp.dataset.hole) - 1;
    inp.value = course.stroke_index[h];
  });
  updateStartRoundButtonState();
}

function collectCourseHoles() {
  const holeCount = Number(document.getElementById('course-hole-count').value);
  const pars = new Array(holeCount).fill(null);
  const strokeIndex = new Array(holeCount).fill(null);

  document.querySelectorAll('.course-par-input').forEach(inp => {
    const h = Number(inp.dataset.hole) - 1;
    pars[h] = Number(inp.value) || null;
  });
  document.querySelectorAll('.course-hcp-input').forEach(inp => {
    const h = Number(inp.dataset.hole) - 1;
    strokeIndex[h] = Number(inp.value) || null;
  });

  return { holeCount, pars, strokeIndex };
}

// Returns an error message string, or null if everything checks out.
function validateCourseHoles(holeCount, pars, strokeIndex) {
  if (pars.some(p => p == null || p < 2 || p > 6)) {
    return 'Every hole needs a par between 2 and 6.';
  }
  if (strokeIndex.some(s => s == null || s < 1 || s > holeCount)) {
    return `Every hole needs a handicap ranking between 1 and ${holeCount}.`;
  }
  if (new Set(strokeIndex).size !== holeCount) {
    return `Each handicap ranking (1–${holeCount}) should be used exactly once.`;
  }
  return null;
}

// Duplicate check now runs against the full shared library (state.myCourses
// already holds every course, not just this user's), since courses are
// global — nobody should be able to create a second "Pebble Beach" just
// because someone else made the first one.
function isDuplicateCourse(name, location, excludeId) {
  const normalize = s => s.trim().toLowerCase();
  return (state.myCourses || []).some(c =>
    c.id !== excludeId &&
    normalize(c.name) === normalize(name) && normalize(c.location) === normalize(location)
  );
}

// Shared by both save buttons. Returns the saved course row on success
// (so callers know its id), or null if validation/save failed — the
// relevant toast has already been shown in that case.
async function saveCourseCore() {
  const name = document.getElementById('course-upload-name').value.trim();
  const location = document.getElementById('course-upload-location').value.trim();

  if (!name) {
    showToast('Give the course a name first');
    return null;
  }
  if (!location) {
    showToast('Location is required');
    return null;
  }
  if (isDuplicateCourse(name, location, state.editingCourseId)) {
    showToast('That course already exists — check the course list');
    return null;
  }

  const { holeCount, pars, strokeIndex } = collectCourseHoles();
  const errorMsg = validateCourseHoles(holeCount, pars, strokeIndex);
  if (errorMsg) {
    showToast(errorMsg);
    return null;
  }

  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) {
    showToast('You need to be logged in to save a course');
    return null;
  }

  // When editing, fall back to the course's already-stored API metadata so
  // that saving an API-sourced course doesn't silently reset it to manual and
  // drop external_id — the key findOrSaveApiCourse uses to avoid re-importing.
  // Priority: a fresh import wins, else keep what's on the existing row, else default.
  const existingCourse = state.editingCourseId
    ? (state.myCourses || []).find(c => c.id === state.editingCourseId)
    : null;
  const importInfo = window.currentCourseImport;

  const payload = {
    name,
    location,
    hole_count: holeCount,
    pars,
    stroke_index: strokeIndex,
    source: importInfo?.source ?? existingCourse?.source ?? 'manual',
    external_id: importInfo?.external_id ?? existingCourse?.external_id ?? null,
    api_club_name: importInfo?.api_club_name ?? existingCourse?.api_club_name ?? null,
    api_location: importInfo?.api_location ?? existingCourse?.api_location ?? null
  };

  const query = state.editingCourseId
    ? supabaseClient.from('courses').update(payload).eq('id', state.editingCourseId)
    : supabaseClient.from('courses').insert({ ...payload, user_id: user.id });

  let { data, error } = await query.select().single();

  if (error && error.code === '42703') {
    const fallbackPayload = { name, location, hole_count: holeCount, pars, stroke_index: strokeIndex };
    const fallbackQuery = state.editingCourseId
      ? supabaseClient.from('courses').update(fallbackPayload).eq('id', state.editingCourseId)
      : supabaseClient.from('courses').insert({ ...fallbackPayload, user_id: user.id });
    ({ data, error } = await fallbackQuery.select().single());
  }

  if (error) {
    // 23505 = unique constraint violation — catches the rare case where
    // someone else saved the same name+location between our check above
    // and this save actually landing.
    if (error.code === '23505') {
      showToast('That course already exists — check the course list');
    } else {
      console.error(error);
      showToast('Could not save course — check your connection');
    }
    return null;
  }

  window.currentCourseImport = null;
  return data;
}

async function saveCourse() {
  const wasEditing = !!state.editingCourseId;
  const saved = await saveCourseCore();
  if (!saved) return;

  showToast(`${saved.name} saved`);
  showScreen(wasEditing ? 'screen-course-manage' : 'screen-home');
  if (wasEditing) await renderCourseManageList();
}

async function saveCourseAndStartRound() {
  const saved = await saveCourseCore();
  if (!saved) return;

  showToast(`${saved.name} saved`);
  await resetSetupScreen();
  applySelectedCourse(saved.id);
  showScreen('screen-setup');
}

// ---------------------------------------------------------
// Manage (edit/delete) saved courses
// ---------------------------------------------------------
// Lists every course in the shared library. Edit/delete controls only
// show for the course's own creator (isOwner) — enforced both here in
// the UI and by the courses RLS policies, so this isn't just cosmetic.
// Courses whose creator's account has since been deleted (user_id is
// null) show with no edit/delete controls for anyone, since they no
// longer have an owner — they just keep working, permanently.
async function renderCourseManageList() {
  const { data: { user } } = await supabaseClient.auth.getUser();
  const isAdmin = user?.app_metadata?.is_admin === true;

  // Course management outside the start-round flow is admin-only now.
  // Non-admins get a read-only view, so hide the "+ Upload a course" button.
  // Using style.display rather than the [hidden] attribute to sidestep the
  // specificity issue where .btn display rules can override [hidden].
  const addBtn = document.getElementById('btn-manage-add-course');
  if (addBtn) addBtn.style.display = isAdmin ? '' : 'none';

  // Stash the admin flag so renderCourseManageRows() can re-render on every
  // keystroke of the filter without another getUser() round-trip.
  state.isCourseAdmin = isAdmin;

  const courses = await loadMyCourses();
  state.myCourses = courses;

  // Client-side filter box: no button, no round-trip. It only ever searches
  // courses already saved (state.myCourses) — the list loaded just above.
  const filterInput = document.getElementById('course-filter-input');
  if (filterInput) {
    filterInput.value = '';
    if (filterInput.dataset.initialized !== 'true') {
      filterInput.dataset.initialized = 'true';
      filterInput.addEventListener('input', () => {
        renderCourseManageRows(filterCoursesByQuery(state.myCourses || [], filterInput.value));
      });
    }
  }

  renderCourseManageRows(courses);
}

// Case-insensitive match against name + location. Empty query returns all.
function filterCoursesByQuery(courses, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return courses;
  return courses.filter(c =>
    `${c.name || ''} ${c.location || ''}`.toLowerCase().includes(q)
  );
}

// Renders whatever list it's handed — the full set on open, or a filtered
// subset while searching. Reads the admin flag off state (set above).
function renderCourseManageRows(courses) {
  const isAdmin = state.isCourseAdmin === true;
  const list = document.getElementById('course-manage-list');
  list.innerHTML = '';

  if (!courses || courses.length === 0) {
    const noneSaved = (state.myCourses || []).length === 0;
    list.innerHTML = `<div class="course-manage-empty">${noneSaved ? 'No saved courses yet.' : 'No courses match your search.'}</div>`;
    return;
  }

  courses.forEach(c => {
    const row = document.createElement('div');
    row.className = 'course-manage-row';
    const canManage = isAdmin;
    // Whole row opens the read-only detail view (all users). The info area
    // carries role="button" + a keydown handler so keyboard users get the
    // same target; the row-level click covers mouse/touch. Edit/delete stop
    // propagation so they don't also fire the detail open.
    row.innerHTML = `
      <div class="course-manage-info" role="button" tabindex="0" data-id="${c.id}">
        <span class="course-manage-name">${escapeHtml(c.name)} - ${escapeHtml(c.location)}</span>
        <span class="course-manage-meta">${c.hole_count} holes</span>
      </div>
      <div class="course-manage-actions">
        ${canManage ? `
          <button class="icon-btn" data-action="edit" data-id="${c.id}" aria-label="Edit course">✏️</button>
          <button class="icon-btn" data-action="delete" data-id="${c.id}" aria-label="Delete course">🗑️</button>
        ` : ''}
        <span class="course-manage-chevron" aria-hidden="true">›</span>
      </div>
    `;
    row.addEventListener('click', () => openCourseDetail(c.id));
    row.querySelector('.course-manage-info').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openCourseDetail(c.id);
      }
    });
    list.appendChild(row);
  });

  list.querySelectorAll('[data-action="edit"]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await startEditingCourse(btn.dataset.id);
      showScreen('screen-course-upload');
    });
  });
  list.querySelectorAll('[data-action="delete"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteCourse(btn.dataset.id);
    });
  });
}

// Opens the read-only detail view for a saved course. Available to all
// users (unlike edit/delete). Pulls the course from the already-loaded
// state.myCourses — no extra fetch.
async function openCourseDetail(courseId) {
  const course = (state.myCourses || []).find(c => String(c.id) === String(courseId));
  if (!course) {
    showToast('Could not open that course');
    return;
  }
  renderCourseDetail(course);
  showScreen('screen-course-detail');
}

// Builds a read-only scorecard grid (Hole / Par / Hcp) for a course,
// reusing the .scorecard-table styles from the round-history view. 18-hole
// courses get OUT / IN / TOT par totals; 9-hole courses get a single TOT
// column. Handicap has no meaningful total, so those summary cells em-dash.
function renderCourseDetail(course) {
  document.getElementById('course-detail-name').textContent =
    `${course.name || 'Course'}${course.location ? ` - ${course.location}` : ''}`;

  const pars = Array.isArray(course.pars) ? course.pars : [];
  const si = Array.isArray(course.stroke_index) ? course.stroke_index : [];
  const holeCount = course.hole_count || pars.length || 0;

  document.getElementById('course-detail-meta').textContent =
    holeCount ? `${holeCount} holes` : '';

  const wrap = document.getElementById('course-detail-scorecard');

  if (!holeCount) {
    wrap.innerHTML = '<div class="course-manage-empty">No hole data saved for this course.</div>';
    return;
  }

  const parCell = i => (pars[i] != null && pars[i] !== '') ? pars[i] : '—';
  const hcpCell = i => (si[i] != null && si[i] !== '') ? si[i] : '—';
  const sumPars = (from, to) => {
    let total = 0;
    for (let i = from; i < to; i++) {
      const p = Number(pars[i]);
      if (Number.isFinite(p)) total += p;
    }
    return total;
  };

  const is18 = holeCount === 18;

  // Builds one nine (or a partial course) as its own table, so the two
  // nines stack vertically instead of running off the side and needing a
  // horizontal scroll. `from`/`to` are 0-based hole indices; `summaryLabel`
  // heads the trailing sum column (OUT / IN / TOT).
  const buildNine = (from, to, summaryLabel) => {
    let headHoles = '', parHoles = '', hcpHoles = '';
    for (let i = from; i < to; i++) {
      headHoles += `<th class="sc-score"><span class="sc-holenum">${i + 1}</span></th>`;
      parHoles += `<td class="sc-score">${parCell(i)}</td>`;
      hcpHoles += `<td class="sc-score">${hcpCell(i)}</td>`;
    }
    return `
      <div class="scorecard-scroll">
        <table class="scorecard-table">
          <thead>
            <tr>
              <th class="sc-rowhead sc-corner">Hole</th>
              ${headHoles}
              <th class="sc-score sc-summarycol">${summaryLabel}</th>
            </tr>
          </thead>
          <tbody>
            <tr class="sc-subrow">
              <td class="sc-rowhead">Par</td>
              ${parHoles}
              <td class="sc-score sc-summarycol">${sumPars(from, to)}</td>
            </tr>
            <tr>
              <td class="sc-rowhead">Hcp</td>
              ${hcpHoles}
              <td class="sc-score sc-summarycol">—</td>
            </tr>
          </tbody>
        </table>
      </div>
    `;
  };

  if (is18) {
    wrap.innerHTML =
      buildNine(0, 9, 'OUT') +
      buildNine(9, 18, 'IN') +
      `<div class="course-detail-total">Total par <strong>${sumPars(0, 18)}</strong></div>`;
  } else {
    wrap.innerHTML = buildNine(0, holeCount, 'TOT');
  }
}

async function deleteCourse(courseId) {
  const course = (state.myCourses || []).find(c => c.id === courseId);
  const label = course ? `${course.name} - ${course.location}` : 'this course';
  if (!confirm(`Delete ${label}? This can't be undone.`)) return;

  const { error } = await supabaseClient.from('courses').delete().eq('id', courseId);
  if (error) {
    console.error(error);
    showToast('Could not delete — check your connection');
    return;
  }

  showToast('Course deleted');
  await renderCourseManageList();
}

// Loads the full shared course library — every course, from every
// user, regardless of source. No user_id filter here: courses are a
// shared resource, not personal data. (Auth is still required just
// because this is only ever called from screens behind a login.)
async function loadMyCourses() {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabaseClient
    .from('courses')
    .select('*')
    .order('name', { ascending: true });

  if (error) {
    console.error(error);
    return [];
  }
  return data || [];
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeCourseSearch);
} else {
  initializeCourseSearch();
}
