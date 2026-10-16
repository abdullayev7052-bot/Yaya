import { useCallback, useEffect, useState } from 'react';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as api from './src/api';
import Login from './src/screens/Login';
import Collector from './src/screens/Collector';
import Manager from './src/screens/Manager';
import { s } from './src/ui';

export default function App() {
  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.screen} edges={['top', 'bottom']}>
        <StatusBar style="dark" />
        <Root />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function Root() {
  const [session, setSession] = useState(api.getSession());
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (session?.mode !== 'collector') return undefined;
    api.startAutoSync();
    return api.onSyncState(() => {
      if (!api.getSession()) setSession(null);
      refresh();
    });
  }, [session, refresh]);

  const logout = () => { api.logout(); setSession(null); };

  if (!session) return <Login onDone={() => setSession(api.getSession())} />;
  if (session.mode === 'manager') return <Manager session={session} onLogout={logout} />;
  return <Collector session={session} tick={tick} refresh={refresh} onLogout={logout} />;
}
