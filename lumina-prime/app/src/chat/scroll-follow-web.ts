import type { createScrollFollow } from './scroll-follow';

type ScrollEvent = { nativeEvent: {
  contentOffset: { y: number }; contentSize: { height: number }; layoutMeasurement: { height: number };
} };
type Sample = { y: number; height: number; viewport: number };
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
function touchPosition(value: unknown): number | null {
  if (!object(value) || !object(value.touches)) return null;
  const first = value.touches[0];
  return object(first) && typeof first.clientY === 'number' && Number.isFinite(first.clientY) ? first.clientY : null;
}

// RN Web 0.21.4 emits onScroll, not native drag/momentum callbacks.
// Input arms a short-lived direction; bare scroll/resize events cannot resume.
export function createWebScrollFollow(controller: ReturnType<typeof createScrollFollow>, now = Date.now) {
  let previous: Sample | null = null;
  let direction = 0;
  let until = 0;
  let touchY: number | null = null;
  const invalidate = () => { previous = null; direction = 0; until = 0; touchY = null; };
  const input = (delta: number) => {
    if (!delta) return;
    controller.suspend(); direction = Math.sign(delta); until = now() + 250;
  };
  return {
    invalidate,
    inputHandlers: {
      onWheel: (value: unknown) => {
        if (object(value) && typeof value.deltaY === 'number' && Number.isFinite(value.deltaY)) input(value.deltaY);
      },
      onTouchStartCapture: (value: unknown) => {
        touchY = touchPosition(value);
      },
      onTouchMoveCapture: (value: unknown) => {
        const y = touchPosition(value);
        if (y !== null && touchY !== null) input(touchY - y);
        touchY = y;
      },
      onKeyDownCapture: (value: unknown) => {
        // Native View and RN Web expose different key-event types. This branch
        // is attached only on web, where View forwards React DOM key events.
        if (!object(value) || typeof value.key !== 'string') return;
        const key = value.key;
        const event = value;
        // Space/arrow keys in controls belong to those controls.
        if (event.ctrlKey || event.metaKey || event.altKey
          || (object(event.target) && typeof event.target.closest === 'function'
            && event.target.closest('input, textarea, button, a, [role="button"], [contenteditable="true"]'))) return;
        if (['ArrowDown', 'PageDown', 'End'].includes(key) || (key === ' ' && !event.shiftKey)) input(1);
        if (['ArrowUp', 'PageUp', 'Home'].includes(key) || (key === ' ' && event.shiftKey)) input(-1);
      },
    },
    onScroll: ({ nativeEvent }: ScrollEvent) => {
      // RN Web uses live getters. Never retain nativeEvent or its nested objects.
      const next = { y: nativeEvent.contentOffset.y, height: nativeEvent.contentSize.height,
        viewport: nativeEvent.layoutMeasurement.height };
      const before = previous;
      previous = next;
      const bottom = next.height - next.viewport - next.y <= 32;
      if (!before || before.height !== next.height || before.viewport !== next.viewport) {
        direction = 0; until = 0; return;
      }
      // Layout growth and downward programmatic scrolling are not reader gestures.
      // Wheel/touch/key input already suspends above; an upward movement also
      // catches dragging the scrollbar or accessibility scrolling.
      if (!bottom && next.y < before.y - 1) controller.suspend();
      if (direction && now() <= until) {
        // Continue the input's inertial sequence, including RN Web's final tick.
        if (direction * (next.y - before.y) > 0) until = now() + 250;
        if (direction > 0 && next.y > Math.max(0, before.y) + 2 && bottom) {
          direction = 0; until = 0; controller.recent();
        }
      }
    },
  };
}
