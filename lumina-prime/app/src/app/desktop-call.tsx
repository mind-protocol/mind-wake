import { useEffect } from 'react';
import CallScreen from '../chat/CallScreen';

export default function DesktopCall() {
  useEffect(() => {
    // Only a readiness signal crosses the boundary. Session and audio stay in the call frame.
    if (typeof window !== 'undefined' && window.parent) window.parent.postMessage('mind.call.ready', '*');
  }, []);
  return <CallScreen />;
}
