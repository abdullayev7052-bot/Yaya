import { StyleSheet } from 'react-native';

// Big targets and high contrast: the app is used in a moving car, outdoors, in a hurry.
export const C = {
  bg: '#F4F6F5',
  card: '#FFFFFF',
  text: '#14201B',
  muted: '#5E6B66',
  line: '#DCE3E0',
  accent: '#1F7A5A',
  accentText: '#FFFFFF',
  warn: '#B54708',
  err: '#B42318',
  ok: '#1F7A5A',
};

export const fmtQty = (n) => {
  const s = Number(n).toFixed(2).replace(/\.?0+$/, '');
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
};
export const fmtTime = (iso) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  pad: { padding: 16 },
  h1: { fontSize: 26, fontWeight: '700', color: C.text },
  h2: { fontSize: 20, fontWeight: '700', color: C.text },
  text: { fontSize: 17, color: C.text },
  muted: { fontSize: 15, color: C.muted },
  input: { backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 12, paddingHorizontal: 16,
    paddingVertical: 14, fontSize: 20, color: C.text },
  btn: { backgroundColor: C.accent, borderRadius: 14, paddingVertical: 18, alignItems: 'center', justifyContent: 'center' },
  btnText: { color: C.accentText, fontSize: 20, fontWeight: '700' },
  btnGhost: { borderWidth: 1, borderColor: C.line, backgroundColor: C.card, borderRadius: 14, paddingVertical: 14,
    alignItems: 'center' },
  btnGhostText: { color: C.text, fontSize: 17, fontWeight: '600' },
  card: { backgroundColor: C.card, borderRadius: 14, borderWidth: 1, borderColor: C.line, padding: 16 },
  err: { color: C.err, fontSize: 16 },
});
