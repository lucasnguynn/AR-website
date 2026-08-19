const SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Installs keyboard containment and restores the element that opened the modal. */
export function containModalFocus(modal: HTMLElement, previouslyFocused: HTMLElement | null): () => void {
  const focusable = () => Array.from(modal.querySelectorAll<HTMLElement>(SELECTOR)).filter((element) => !element.hasAttribute('hidden'));
  focusable()[0]?.focus();
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Tab') return;
    const elements = focusable();
    if (elements.length === 0) { event.preventDefault(); modal.focus(); return; }
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  modal.addEventListener('keydown', onKeyDown);
  return () => {
    modal.removeEventListener('keydown', onKeyDown);
    if (previouslyFocused?.isConnected) previouslyFocused.focus();
  };
}
