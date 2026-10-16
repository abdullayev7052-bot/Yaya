import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { getSyncState, onSyncState, syncNow } from './api';
import * as store from './db';
import { C, fmtTime } from './ui';
import { notify } from './dialog';

// One-line status: tells the collector at a glance whether everything reached the office.
export default function SyncBar({ tick }) {
  const [st, setSt] = useState(getSyncState());
  useEffect(() => onSyncState(setSt), []);
  const pending = store.unsyncedCount();
  const errors = store.errorCount();
  void tick;

  let color = C.ok;
  let text = 'Hammasi yuborilgan ✓';
  if (errors) { color = C.err; text = `${errors} ta yozuv qabul qilinmadi — bosing`; }
  else if (st.syncing) { color = C.muted; text = 'Yuborilmoqda...'; }
  else if (pending) { color = C.warn; text = `${pending} ta yozuv telefonda saqlangan${st.online ? '' : ' · internet yo\'q'}`; }
  if (!errors && !pending && st.lastSync) text += `  · ${fmtTime(st.lastSync)}`;

  return (
    <Pressable onPress={() => {
      if (errors) {
        notify('Qabul qilinmagan yozuvlar', `${store.errors().map((e) => `• ${e.name}: ${e.error}`).join('\n')}\n\nAdmin sozlamani tuzatgach, qayta yuboriladi.`);
        store.retryErrors();
      }
      syncNow();
    }}>
      <View style={{ backgroundColor: color, paddingVertical: 8, paddingHorizontal: 16 }}>
        <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600' }}>{text}</Text>
      </View>
    </Pressable>
  );
}
