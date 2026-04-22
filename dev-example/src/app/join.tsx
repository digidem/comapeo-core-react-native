import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { ErrorBanner } from '@/components/ErrorBanner';
import { LoadingScreen } from '@/components/LoadingScreen';
import { Screen } from '@/components/Screen';
import { Section } from '@/components/Section';
import { ShortId } from '@/components/ShortId';
import { deviceIdPrefix, encodePairingUrl } from '@/lib/pairing';
import { T } from '@/lib/theme';
import { useLocalIpAddress, useLocalPeers } from '@/lib/useLocalPeers';
import { useOwnDeviceInfo } from '@comapeo/core-react';

export default function JoinScreen() {
  const { data: device } = useOwnDeviceInfo();
  const { listening, error } = useLocalPeers();
  const ip = useLocalIpAddress();

  const port = listening?.port ?? null;
  const idPrefix = deviceIdPrefix(device.deviceId);
  const ready = ip != null && port != null;

  return (
    <>
      <Stack.Screen options={{ title: 'Join a project' }} />
      <Screen>
        <View style={styles.intro}>
          <Text style={styles.introText}>
            Ask someone with a project to scan this code and invite this device.
          </Text>
        </View>

        {error ? (
          <ErrorBanner message={`Could not start local peer server: ${error.message}`} />
        ) : null}

        {!ready ? (
          <LoadingScreen label="Starting local discovery…" />
        ) : (
          <QrCard ip={ip} port={port} idPrefix={idPrefix} />
        )}

        <Section header="Encoded payload">
          <Kv k="device" v={device.name ?? '—'} />
          <Kv
            k="deviceId"
            v={idPrefix}
            right={<ShortId id={device.deviceId} label="deviceId" size="xs" />}
            mono
          />
          <Kv k="ip" v={ip ?? '—'} mono />
          <Kv k="port" v={port != null ? String(port) : '—'} mono last />
        </Section>

        <Text style={styles.footerHint}>
          The full deviceId is verified during the Noise handshake after the
          peer connects.
        </Text>
      </Screen>
    </>
  );
}

function QrCard({ ip, port, idPrefix }: { ip: string; port: number; idPrefix: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(encodePairingUrl({ ip, port, idPrefix }));
  }, [ip, port, idPrefix]);
  if (!url) return null;
  return (
    <View style={styles.qrWrap}>
      <View style={styles.qrCard}>
        <QRCode value={url} size={220} color={T.text} backgroundColor="#fff" />
      </View>
    </View>
  );
}

function Kv({
  k,
  v,
  right,
  mono,
  last,
}: {
  k: string;
  v: string;
  right?: React.ReactNode;
  mono?: boolean;
  last?: boolean;
}) {
  return (
    <View
      style={[
        styles.kv,
        !last && { borderBottomColor: T.separator, borderBottomWidth: T.separatorWidth },
      ]}
    >
      <Text style={styles.kvKey}>{k}</Text>
      <Text style={[styles.kvVal, mono && { fontFamily: T.mono }]} numberOfLines={1}>
        {v}
      </Text>
      {right ? <View style={styles.kvRight}>{right}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  intro: {
    paddingHorizontal: 24,
    paddingTop: 4,
    paddingBottom: 16,
    alignItems: 'center',
  },
  introText: {
    fontSize: 15,
    lineHeight: 22,
    color: T.textMuted,
    textAlign: 'center',
    fontFamily: T.font,
    maxWidth: 320,
  },
  qrWrap: {
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  qrCard: {
    backgroundColor: '#fff',
    padding: 20,
    borderRadius: 20,
  },
  kv: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  kvKey: {
    fontSize: 13,
    color: T.textMuted,
    minWidth: 76,
    fontFamily: T.font,
  },
  kvVal: {
    flex: 1,
    fontSize: 15,
    color: T.text,
    fontFamily: T.font,
  },
  kvRight: { flexShrink: 0 },
  footerHint: {
    fontSize: 12,
    color: T.textMuted,
    textAlign: 'center',
    paddingHorizontal: 32,
    paddingTop: 16,
    lineHeight: 18,
    fontFamily: T.font,
  },
});
