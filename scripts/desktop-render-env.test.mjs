import {test} from 'node:test';
import assert from 'node:assert/strict';
import {desktopRenderEnv} from './start-local.mjs';
test('rendering recovery is opt-in and applies only to the desktop',()=>{
  assert.deepEqual(desktopRenderEnv({},'desktop',{}),{});
  assert.deepEqual(desktopRenderEnv({desktopDisableGpu:true},'agent',{}),{});
  assert.deepEqual(desktopRenderEnv({desktopDisableGpu:true},'desktop',{}),{
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--disable-gpu --disable-gpu-compositing',
  });
});
test('existing WebView flags are preserved',()=>{
  assert.equal(desktopRenderEnv({desktopDisableGpu:true},'desktop',{
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--lang=fr',
  }).WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,'--lang=fr --disable-gpu --disable-gpu-compositing');
});
