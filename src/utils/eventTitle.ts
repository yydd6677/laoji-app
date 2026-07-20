// Keep an empty event title in the domain model. Feishu supplies these two
// placeholders only at render time, so editing an untitled event stays empty.
export function eventListTitle(title: string | null | undefined): string {
  return title?.trim() ? title : '(无主题)';
}

export function eventDetailTitle(title: string | null | undefined): string {
  return title?.trim() ? title : '无主题';
}
