// Only a user gesture or the explicit button can resume a suspended follow.
// Native onScroll events alone cannot distinguish layout/anchor corrections.
type Position = {
  contentOffset: { y: number };
  contentSize: { height: number };
  layoutMeasurement: { height: number };
  contentInset?: { bottom: number };
  velocity?: { y: number };
};
type ScrollEvent = { nativeEvent: Position };

export function createScrollFollow(scrollToEnd: () => void, changed: (following: boolean) => void) {
  let following = true;
  let height = 0;
  let viewport = 0;
  let gesture: Position | null = null;
  let phase: 'idle' | 'drag' | 'momentum' = 'idle';
  const setFollowing = (value: boolean) => {
    if (value !== following) { following = value; changed(value); }
  };
  const cancelGesture = () => { gesture = null; phase = 'idle'; };
  const follow = () => { if (following && height > 0 && viewport > 0) scrollToEnd(); };
  const finish = (position: Position) => {
    const start = gesture;
    cancelGesture();
    // Ignore geometry changes mid-gesture (keyboard, resizing, new snapshot).
    // Require movement towards the end, not a bounce at the top of a short list.
    if (start && position.contentSize.height === start.contentSize.height
      && position.layoutMeasurement.height === start.layoutMeasurement.height
      && (position.contentInset?.bottom ?? 0) === (start.contentInset?.bottom ?? 0)
      && position.contentOffset.y > Math.max(0, start.contentOffset.y) + 2
      && position.contentSize.height + (position.contentInset?.bottom ?? 0)
        - position.layoutMeasurement.height - position.contentOffset.y <= 32) {
      setFollowing(true);
      follow();
    }
  };
  return {
    setScrollToEnd: (callback: () => void) => { scrollToEnd = callback; },
    onLayout: (event: { nativeEvent: { layout: { height: number } } }) => {
      const next = event.nativeEvent.layout.height;
      if (next !== viewport) { cancelGesture(); viewport = next; follow(); }
    },
    onContentSizeChange: (_width: number, next: number) => {
      if (next !== height) { cancelGesture(); height = next; follow(); }
    },
    onScrollBeginDrag: ({ nativeEvent }: ScrollEvent) => {
      gesture = {
        contentOffset: { y: nativeEvent.contentOffset.y },
        contentSize: { height: nativeEvent.contentSize.height },
        layoutMeasurement: { height: nativeEvent.layoutMeasurement.height },
        contentInset: { bottom: nativeEvent.contentInset?.bottom ?? 0 },
      };
      phase = 'drag'; setFollowing(false);
    },
    onScrollEndDrag: ({ nativeEvent }: ScrollEvent) => {
      if (phase !== 'drag') return;
      if (nativeEvent.velocity?.y) phase = 'momentum';
      else finish(nativeEvent);
    },
    onMomentumScrollEnd: ({ nativeEvent }: ScrollEvent) => {
      if (phase === 'momentum') finish(nativeEvent);
    },
    contentChanged: cancelGesture,
    suspend: () => { cancelGesture(); setFollowing(false); },
    recent: () => { cancelGesture(); setFollowing(true); follow(); },
    // The mounted viewport may not emit onLayout again when a new call starts.
    reset: () => { cancelGesture(); height = 0; setFollowing(true); },
  };
}
