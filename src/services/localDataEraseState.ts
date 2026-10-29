// Revokes in-flight external projections before erase deletes their durable roots.
let erasing = false;
let revision = 0;
export function beginLocalDataErase(): void { revision += 1; erasing = true; }
export function finishLocalDataErase(): void { erasing = false; }
export function localDataEraseRevision(): number { return revision; }
export function isLocalDataErasing(): boolean { return erasing; }
