// Keep an empty event title in the domain model. These two placeholders exist
// only at render time, so editing an untitled event stays empty.
export function eventListTitle(title: string | null | undefined): string {
  return title?.trim() ? title : '(无主题)';
}

export function eventDetailTitle(title: string | null | undefined): string {
  return title?.trim() ? title : '无主题';
}
