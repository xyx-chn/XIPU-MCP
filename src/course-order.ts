const courseCodePrefix = /^[A-Z]{3}[0-9]{3}(?![A-Za-z0-9])/;

export function hasCourseCodePrefix(name: string): boolean {
  return courseCodePrefix.test(name.trimStart());
}

export function prioritizeCourses<T extends { name: string }>(courses: readonly T[]): T[] {
  const teaching: T[] = [];
  const other: T[] = [];
  for (const course of courses) {
    (hasCourseCodePrefix(course.name) ? teaching : other).push(course);
  }
  return [...teaching, ...other];
}
