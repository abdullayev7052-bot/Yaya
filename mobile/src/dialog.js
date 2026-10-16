import { Alert, Platform } from 'react-native';

// Alert.alert is a no-op in the browser build, so fall back to the browser dialogs there.
export function notify(title, message) {
  if (Platform.OS === 'web') globalThis.alert(`${title}\n\n${message}`);
  else Alert.alert(title, message);
}

export function ask(title, message, okText, onOk) {
  if (Platform.OS === 'web') {
    if (globalThis.confirm(`${title}\n\n${message}`)) onOk();
    return;
  }
  Alert.alert(title, message, [{ text: 'Yo\'q' }, { text: okText, onPress: onOk }]);
}
