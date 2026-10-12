import { describe, expect, it } from 'vitest';
import {
  extractHoles,
  normalizeCourseDetails,
  validateCourseId
} from '../edge-functions/get-golf-course/get-golf-course.ts';

describe('get-golf-course API normalization', () => {
  it('accepts opaque alphanumeric course IDs without numeric coercion', () => {
    expect(validateCourseId('pmyjyz8s')).toBe('pmyjyz8s');
    expect(validateCourseId('12345678901')).toBe('12345678901');
    expect(validateCourseId('9007199254740991')).toBe('9007199254740991');
    expect(validateCourseId('id/with/path')).toBeNull();
    expect(validateCourseId('x'.repeat(65))).toBeNull();
    expect(validateCourseId('123.4')).toBeNull();
    expect(validateCourseId(123)).toBe(123);
  });

  it('ignores additive course and hole fields while preserving optional location data', () => {
    const apiResponse = {
      course: {
        id: 'pmyjyz8s',
        club_name: 'Example Golf Club',
        course_name: 'Example Course',
        location: {
          city: 'Example City',
          state: 'CA',
          latitude: 36.5,
          longitude: -121.8
        },
        newly_added_course_field: 'ignored',
        tees: {
          male: [{
            holes: [
              { par: 4, handicap: 1, yardage: 400, meters: 366, newly_added_hole_field: true },
              { par: 3, stroke_index: 2, yardage: 160, meters: 146 }
            ]
          }]
        }
      }
    };

    const normalized = normalizeCourseDetails(apiResponse, 'pmyjyz8s');
    expect(normalized).toEqual({
      id: 'pmyjyz8s',
      club_name: 'Example Golf Club',
      course_name: 'Example Course',
      location: apiResponse.course.location,
      hole_count: 2,
      holes: [
        { hole_number: 1, par: 4, handicap: 1 },
        { hole_number: 2, par: 3, handicap: 2 }
      ],
      limited: false
    });
  });

  it('handles omitted coordinates and non-object hole entries', () => {
    const holes = extractHoles({
      male: [{ holes: [null, { par: 5, handicap: 3, yardage: 500 }] }]
    });
    expect(holes).toEqual([{ par: 5, handicap: 3, yardage: 500 }]);

    const normalized = normalizeCourseDetails({
      course: { location: { city: 'Example City' }, tees: { male: [{ holes }] } }
    }, 789);
    expect(normalized?.id).toBe(789);
    expect(normalized?.location).toEqual({ city: 'Example City' });
    expect(normalized?.holes).toEqual([{ hole_number: 1, par: 5, handicap: 3 }]);
  });
});