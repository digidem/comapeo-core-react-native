import { Platform, ToastAndroid } from 'react-native';

// Lightweight cross-platform toast.
// Android: uses native ToastAndroid.
// iOS: emits to a JS subscriber (mounted by ToastHost) which renders an in-app
// snackbar — there's no native iOS equivalent.

type Listener = (message: string) => void;
const listeners = new Set<Listener>();

export function showToast(message: string) {
  if (Platform.OS === 'android') {
    ToastAndroid.show(message, ToastAndroid.SHORT);
    return;
  }
  for (const l of listeners) l(message);
}

export function subscribeToast(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
