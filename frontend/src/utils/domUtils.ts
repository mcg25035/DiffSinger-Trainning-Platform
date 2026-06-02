/**
 * Focuses an HTMLInputElement and moves the cursor to the far right (end) of its text.
 * Optional delay can be provided to handle browser default behaviors or event loops.
 */
export function focusAndMoveCursorToEnd(input: HTMLInputElement | null, delay = 0) {
  if (!input) return;
  setTimeout(() => {
    input.focus();
    const val = input.value;
    input.setSelectionRange(val.length, val.length);
  }, delay);
}
