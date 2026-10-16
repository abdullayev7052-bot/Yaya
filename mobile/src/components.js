import { useEffect, useRef } from 'react';
import { Image, Platform, Pressable, Text, View } from 'react-native';
import { getBrand } from './api';
import { C, s } from './ui';

export const fmtMoney = (n) => (n == null ? '—' : String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '));

export function Logo({ size = 48 }) {
  const b = getBrand();
  if (b.logo) return <Image source={{ uri: b.logo }} style={{ width: size, height: size }} resizeMode="contain" accessibilityLabel="Logo" />;
  return null;
}

export function Header({ title, onBack, right }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, gap: 8 }}>
      {onBack && (
        <Pressable onPress={onBack} hitSlop={16} style={{ paddingRight: 6 }}>
          <Text style={{ fontSize: 28, color: C.muted }}>←</Text>
        </Pressable>
      )}
      <Text style={[s.h2, { flex: 1 }]} numberOfLines={2}>{title}</Text>
      {right}
    </View>
  );
}

export function Tile({ label, value, sub, wide }) {
  return (
    <View style={[s.card, { flexBasis: wide ? '100%' : '47%', flexGrow: 1, padding: 12 }]}>
      <Text style={s.muted}>{label}</Text>
      <Text style={{ fontSize: 26, fontWeight: '700', color: C.text }} adjustsFontSizeToFit numberOfLines={1}>{value}</Text>
      {!!sub && <Text style={{ fontSize: 13, color: C.muted }}>{sub}</Text>}
    </View>
  );
}

const STATUS = {
  open: ['Ochiq', C.warn], closed: ['Tasdiq kutmoqda', C.warn], approved: ['Tasdiqlangan', C.ok], rejected: ['Rad etilgan', C.err],
};
export function ShiftBadge({ status }) {
  const [t, color] = STATUS[status] ?? [status, C.muted];
  return (
    <View style={{ borderWidth: 1, borderColor: color, borderRadius: 99, paddingHorizontal: 8, paddingVertical: 2, alignSelf: 'flex-start' }}>
      <Text style={{ color, fontSize: 13, fontWeight: '600' }}>{t}</Text>
    </View>
  );
}

export function Chip({ label, on, onPress }) {
  return (
    <Pressable onPress={onPress} style={[s.btnGhost, { flexGrow: 1, paddingHorizontal: 14, paddingVertical: 10 }, on && { backgroundColor: C.accent, borderColor: C.accent }]}>
      <Text style={[s.btnGhostText, on && { color: C.accentText }]}>{label}</Text>
    </Pressable>
  );
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', ',', '0', '⌫'];

/**
 * Big on-screen number pad. value is a string with ',' as decimal separator.
 * decimals=0 hides the comma key (money). Laptop keyboard works in the browser tester.
 */
export function Keypad({ value, onChange, onSubmit, onCancel, decimals = 2, maxDigits = 6 }) {
  const press = (k) => {
    let next = value;
    if (k === '⌫') next = value.slice(0, -1);
    else if (k === ',') { if (decimals && !value.includes(',')) next = (value || '0') + ','; }
    else if (value === '0') next = k;
    else if (new RegExp(`,\\d{${decimals}}$`).test(value) || value.replace(',', '').length >= maxDigits) return;
    else next = value + k;
    onChange(next);
  };
  const handler = useRef(null);
  handler.current = (e) => {
    if (/^\d$/.test(e.key)) press(e.key);
    else if (e.key === ',' || e.key === '.') press(',');
    else if (e.key === 'Backspace') press('⌫');
    else if (e.key === 'Enter') onSubmit?.();
    else if (e.key === 'Escape') onCancel?.();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const onKey = (e) => {
      if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return;
      handler.current?.(e);
    };
    // Capture phase: a focused button (e.g. a product chip) must not swallow Enter.
    globalThis.addEventListener('keydown', onKey, true);
    return () => globalThis.removeEventListener('keydown', onKey, true);
  }, []);
  return (
    <View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {KEYS.map((k) => (k === ',' && !decimals ? <View key={k} style={{ width: '31.5%', flexGrow: 1 }} /> : (
        <Pressable key={k} onPress={() => press(k)}
          style={({ pressed }) => [s.card, { width: '31.5%', flexGrow: 1, alignItems: 'center', justifyContent: 'center',
            padding: 0, minHeight: 60 }, pressed && { backgroundColor: C.line }]}>
          <Text style={{ fontSize: 30, fontWeight: '600', color: C.text }}>{k}</Text>
        </Pressable>
      )))}
    </View>
  );
}

export const toNumber = (v) => Number(String(v).replace(',', '.'));
export const digitsOf = (v) => String(v ?? '').replace(/\D/g, '');

// Search by name, address or phone digits ("93 111" finds 931112233).
export function matches(item, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const d = digitsOf(q);
  return item.name.toLowerCase().includes(q) || (item.address ?? '').toLowerCase().includes(q)
    || (d.length >= 2 && digitsOf(item.phone).includes(d));
}
