import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import * as api from '../api';
import { Chip, Logo } from '../components';
import { C, s } from '../ui';

// One app, two kinds of people: milk collectors (phone + PIN) and managers
// (the same login/password as the web panel).
export default function Login({ onDone }) {
  const [mode, setMode] = useState('collector');
  const [id, setId] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [taps, setTaps] = useState(0);
  const [url, setUrl] = useState(api.getServerUrl());
  const [brand, setBrand] = useState(api.getBrand());

  useEffect(() => { api.refreshBrand().then(setBrand); }, []);

  const collector = mode === 'collector';
  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      if (taps >= 5) api.setServerUrl(url);
      if (collector) await api.login(id.replace(/\D/g, ''), secret);
      else await api.managerLogin(id, secret);
      onDone();
    } catch (e) {
      setErr(e.offline ? 'Internet yo\'q. Birinchi kirish uchun internet kerak.' : e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={[s.pad, { flexGrow: 1, justifyContent: 'center', gap: 16 }]} keyboardShouldPersistTaps="handled">
        <Pressable onPress={() => setTaps((t) => t + 1)} style={{ alignItems: 'center', gap: 8 }}>
          <Logo size={brand.logo ? 96 : 0} />
          <Text style={[s.h1, { fontSize: 36, color: C.accent, textAlign: 'center' }]}>{brand.companyName || 'Yaya'}</Text>
        </Pressable>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Chip label="Sut yig'uvchi" on={collector} onPress={() => { setMode('collector'); setErr(''); }} />
          <Chip label="Rahbar" on={!collector} onPress={() => { setMode('manager'); setErr(''); }} />
        </View>
        {taps >= 5 && (
          <TextInput style={s.input} value={url} onChangeText={setUrl} placeholder="https://server-manzili"
            autoCapitalize="none" autoCorrect={false} keyboardType="url" />
        )}
        <TextInput style={s.input} value={id} onChangeText={setId} placeholder={collector ? 'Telefon: 901234567' : 'Login'}
          keyboardType={collector ? 'phone-pad' : 'default'} autoCapitalize="none" autoCorrect={false} />
        <TextInput style={s.input} value={secret} onChangeText={setSecret} placeholder={collector ? 'PIN' : 'Parol'}
          keyboardType={collector ? 'number-pad' : 'default'} secureTextEntry maxLength={collector ? 6 : 100}
          autoCapitalize="none" onSubmitEditing={submit} />
        {!!err && <Text style={s.err}>{err}</Text>}
        <Pressable style={[s.btn, busy && { opacity: 0.6 }]} onPress={submit} disabled={busy || !id || !secret}>
          <Text style={s.btnText}>{busy ? 'Kirilmoqda...' : 'Kirish'}</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
