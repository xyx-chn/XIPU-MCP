import test from 'node:test';
import assert from 'node:assert/strict';
import { hasCourseCodePrefix, prioritizeCourses } from '../src/course-order.js';

test('course codes require exactly three uppercase ASCII letters and three digits at the start', () => {
  for (const name of ['COS305-2627-S1-Course', 'EEE335 Electrical Machines', 'MEC301', '  PSP305: Final Year Project']) {
    assert.equal(hasCourseCodePrefix(name), true, name);
  }
  for (const name of ['Academic Literacies Center', 'cos305-Course', 'CoS305-Course', 'AB123-Course', 'ABCD123-Course', 'COS30-Course', 'COS3051-Course', 'COS305A-Course', 'Welcome to COS305', 'ＣＯＳ305-Course']) {
    assert.equal(hasCourseCodePrefix(name), false, name);
  }
});

test('coded course names appear first while both groups preserve their original order', () => {
  const courses = [
    { id: 'a', name: 'Academic Literacies Center', shortName: 'COS305' },
    { id: 'b', name: 'MEC304-2627-S1-Optimization', shortName: 'MEC304' },
    { id: 'c', name: 'Programme announcements', shortName: 'EEE335' },
    { id: 'd', name: 'COS305-2627-S1-Embedded Systems', shortName: 'Other' },
    { id: 'e', name: 'PSP305-2627-S1-Final Year Project', shortName: 'PSP305' },
  ];
  const ordered = prioritizeCourses(courses);
  assert.deepEqual(ordered.map(course => course.id), ['b', 'd', 'e', 'a', 'c']);
  assert.deepEqual(courses.map(course => course.id), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(ordered.length, courses.length);
  assert.equal(ordered[0], courses[1]);
});
