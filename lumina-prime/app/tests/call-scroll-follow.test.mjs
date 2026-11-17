import { test as it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createScrollFollow } from '../src/chat/scroll-follow.ts';
import { createWebScrollFollow } from '../src/chat/scroll-follow-web.ts';

it('keeps the mounted viewport measurable when starting another call', () => {
  const pin = mock.fn();
  const follow = createScrollFollow(pin, () => {});
  follow.onLayout({ nativeEvent: { layout: { height: 400 } } });
  follow.onContentSizeChange(300, 800);
  follow.reset();
  pin.mock.resetCalls();
  follow.onContentSizeChange(300, 900);
  assert.equal(pin.mock.callCount(), 1);
});

it('follows growing content and programmatic movement but respects upward scrolling', () => {
  const pin = mock.fn();
  const changed = mock.fn();
  const follow = createScrollFollow(pin, changed);
  const web = createWebScrollFollow(follow);
  const scroll = (y, height) => web.onScroll({ nativeEvent: {
    contentOffset: { y }, contentSize: { height }, layoutMeasurement: { height: 400 },
  } });
  follow.onLayout({ nativeEvent: { layout: { height: 400 } } });
  follow.onContentSizeChange(300, 800);
  scroll(400, 800);
  scroll(400, 1200);
  scroll(600, 1200);
  assert.equal(changed.mock.callCount(), 0);
  scroll(500, 1200);
  assert.deepEqual(changed.mock.calls.at(-1).arguments, [false]);
  pin.mock.resetCalls();
  follow.onContentSizeChange(300, 1400);
  assert.equal(pin.mock.callCount(), 0);
});
