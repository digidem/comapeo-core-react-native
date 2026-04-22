import { CameraView, useCameraPermissions } from "expo-camera";
import { Stack, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { DangerButton } from "@/components/DangerButton";
import { ErrorBanner } from "@/components/ErrorBanner";
import { Glyph } from "@/components/Glyph";
import { HeaderButton } from "@/components/HeaderButton";
import { PrimaryButton } from "@/components/PrimaryButton";
import { Row } from "@/components/Row";
import { Screen } from "@/components/Screen";
import { Section } from "@/components/Section";
import { ShortId } from "@/components/ShortId";
import { StatusChip } from "@/components/StatusChip";
import { decodePairingUrl, type PairingPayload } from "@/lib/pairing";
import { T } from "@/lib/theme";
import { useProjectId } from "@/lib/useProjectId";
import { waitForPeerConnection } from "@/lib/useLocalPeers";
import {
  useClientApi,
  useProjectSettings,
  useSendInvite,
} from "@comapeo/core-react";

type Step =
  | { kind: "scan" }
  | { kind: "connecting"; payload: PairingPayload }
  | { kind: "failed"; message: string }
  | { kind: "picking"; peerDeviceId: string }
  | { kind: "sent"; peerDeviceId: string };

const ROLES = [
  {
    id: "f7c150f5a3a9a855",
    name: "Coordinator",
    description:
      "Can invite others, edit project settings, and manage members. Grants full trust.",
  },
  {
    id: "012fd2d431c0bf60",
    name: "Member",
    description:
      "Can create and edit observations, tracks, and presets. Cannot invite others or change settings.",
  },
] as const;

type RoleId = (typeof ROLES)[number]["id"];

export default function InviteWizard() {
  const router = useRouter();
  const projectId = useProjectId();
  const { data: project } = useProjectSettings({ projectId });
  const [step, setStep] = useState<Step>({ kind: "scan" });

  return (
    <>
      <Stack.Screen
        options={{
          title: titleFor(step),
          presentation: "modal",
          headerLeft: () => (
            <HeaderButton
              label={Platform.OS === "ios" ? "Cancel" : "×"}
              onPress={() => router.back()}
            />
          ),
        }}
      />
      {step.kind === "scan" ? (
        <ScanStep
          onPayload={(payload) => setStep({ kind: "connecting", payload })}
        />
      ) : null}
      {step.kind === "connecting" ? (
        <ConnectStep
          payload={step.payload}
          onConnected={(peerDeviceId) =>
            setStep({ kind: "picking", peerDeviceId })
          }
          onFailed={(message) => setStep({ kind: "failed", message })}
        />
      ) : null}
      {step.kind === "failed" ? (
        <FailedStep
          message={step.message}
          onRetry={() => setStep({ kind: "scan" })}
        />
      ) : null}
      {step.kind === "picking" ? (
        <PickRoleStep
          projectId={projectId}
          projectName={project.name ?? "Project"}
          peerDeviceId={step.peerDeviceId}
          onSent={() =>
            setStep({ kind: "sent", peerDeviceId: step.peerDeviceId })
          }
        />
      ) : null}
      {step.kind === "sent" ? (
        <SentStep
          peerDeviceId={step.peerDeviceId}
          onDone={() => router.back()}
        />
      ) : null}
    </>
  );
}

function titleFor(step: Step): string {
  if (step.kind === "scan") return "Scan to invite";
  if (step.kind === "connecting") return "Connecting";
  if (step.kind === "failed") return "Could not connect";
  if (step.kind === "picking") return "Invite to project";
  return "Invite sent";
}

// ─────────────────────────────── Scan step ───────────────────────────────

function ScanStep({ onPayload }: { onPayload: (p: PairingPayload) => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const handledRef = useRef(false);

  const onScanned = useCallback(
    (data: string) => {
      if (handledRef.current) return;
      const payload = decodePairingUrl(data);
      if (!payload) return;
      handledRef.current = true;
      onPayload(payload);
    },
    [onPayload],
  );

  if (!permission) {
    return <Screen>{null}</Screen>;
  }
  if (!permission.granted) {
    return (
      <Screen>
        <View style={styles.permissionBlock}>
          <Text style={styles.permissionTitle}>Camera access needed</Text>
          <Text style={styles.permissionBody}>
            To invite another device you need to scan its QR code.
          </Text>
          <PrimaryButton onPress={requestPermission}>
            Grant camera access
          </PrimaryButton>
        </View>
      </Screen>
    );
  }

  return (
    <Screen scroll={false}>
      <View style={styles.viewfinderWrap}>
        <View style={styles.viewfinder}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={({ data }) => onScanned(data)}
          />
          {(["tl", "tr", "bl", "br"] as const).map((c) => (
            <View key={c} style={[styles.corner, cornerStyles[c]]} />
          ))}
        </View>
        <Text style={styles.hint}>
          Align the other device’s QR code inside the frame.
        </Text>
      </View>
    </Screen>
  );
}

// ───────────────────────────── Connect step ─────────────────────────────

function ConnectStep({
  payload,
  onConnected,
  onFailed,
}: {
  payload: PairingPayload;
  onConnected: (peerDeviceId: string) => void;
  onFailed: (message: string) => void;
}) {
  const api = useClientApi();
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const anyApi = api as unknown as {
          connectLocalPeer(opts: {
            address: string;
            port: number;
            name: string;
          }): void;
        };
        anyApi.connectLocalPeer({
          address: payload.ip,
          port: payload.port,
          name: payload.idPrefix,
        });
        const peer = await waitForPeerConnection(api, payload.idPrefix);
        if (!cancelled) onConnected(peer.deviceId);
      } catch (err) {
        if (!cancelled)
          onFailed(err instanceof Error ? err.message : "Connection failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, payload, onConnected, onFailed]);

  return (
    <Screen>
      <View style={styles.centerBlock}>
        <ActivityIndicator size="large" color={T.primary} />
        <Text style={styles.stepTitle}>Connecting to peer…</Text>
        <Text style={styles.stepSub}>
          {payload.ip}:{payload.port}
        </Text>
      </View>
    </Screen>
  );
}

function FailedStep({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <Screen>
      <View style={styles.centerBlock}>
        <View style={[styles.iconCircle, { backgroundColor: "#FEE2E2" }]}>
          <Text style={[styles.iconText, { color: T.danger }]}>⚠</Text>
        </View>
        <Text style={styles.stepTitle}>Could not connect</Text>
        <Text style={styles.stepSub}>
          Check that both devices are on the same network.
        </Text>
        <ErrorBanner message={message} />
        <View style={{ width: 280 }}>
          <PrimaryButton onPress={onRetry}>Retry scan</PrimaryButton>
        </View>
      </View>
    </Screen>
  );
}

// ───────────────────────────── Role pick step ─────────────────────────────

function PickRoleStep({
  projectId,
  projectName,
  peerDeviceId,
  onSent,
}: {
  projectId: string;
  projectName: string;
  peerDeviceId: string;
  onSent: () => void;
}) {
  const [roleId, setRoleId] = useState<RoleId>("012fd2d431c0bf60");
  const send = useSendInvite({ projectId });
  const isPending = send.status === "pending";

  const submit = () => {
    send.mutate({ deviceId: peerDeviceId, roleId }, { onSuccess: onSent });
  };

  return (
    <Screen>
      <Section header="Connected peer">
        <Row
          leading={
            <Glyph
              bg={T.primary}
              ch={peerDeviceId[0]?.toUpperCase() ?? "?"}
              size={36}
            />
          }
          title="Peer connected"
          subtitle={<ShortId id={peerDeviceId} size="xs" />}
          right={<StatusChip label="connected" tone="success" />}
          isLast
        />
      </Section>
      <Section header="Project">
        <Row title={projectName} isLast />
      </Section>
      <Section header="Role">
        {ROLES.map((r, i, arr) => {
          const selected = roleId === r.id;
          return (
            <Row
              key={r.id}
              isLast={i === arr.length - 1}
              onPress={() => setRoleId(r.id)}
              leading={
                <View style={[styles.radio, selected && styles.radioSelected]}>
                  {selected ? <View style={styles.radioInner} /> : null}
                </View>
              }
              title={r.name}
              subtitle={r.description}
              showChevron={false}
            />
          );
        })}
      </Section>
      {send.error ? <ErrorBanner message={send.error.message} /> : null}
      <View style={{ padding: 16 }}>
        <PrimaryButton onPress={submit} disabled={isPending}>
          {isPending ? "Sending…" : "Send invite"}
        </PrimaryButton>
      </View>
    </Screen>
  );
}

// ───────────────────────────── Sent step ─────────────────────────────

function SentStep({
  peerDeviceId,
  onDone,
}: {
  peerDeviceId: string;
  onDone: () => void;
}) {
  return (
    <Screen>
      <View style={styles.centerBlock}>
        <View style={[styles.iconCircle, { backgroundColor: "#FEF3C7" }]}>
          <ActivityIndicator size="small" color="#A16207" />
        </View>
        <Text style={styles.stepTitle}>Waiting for response</Text>
        <Text style={styles.stepSub}>
          The invited device needs to accept on their screen. Leave this open
          until they respond.
        </Text>
        <View style={{ width: 280, gap: 12 }}>
          <DangerButton onPress={onDone}>Cancel invite</DangerButton>
          <PrimaryButton onPress={onDone}>Done</PrimaryButton>
        </View>
      </View>
      <Section header="Invite">
        <Row title="peer" subtitle={<ShortId id={peerDeviceId} size="xs" />} />
        <Row
          isLast
          title="status"
          right={<StatusChip label="pending" tone="warning" />}
        />
      </Section>
    </Screen>
  );
}

const cornerStyles = {
  tl: { top: 18, left: 18, borderTopWidth: 3, borderLeftWidth: 3 },
  tr: { top: 18, right: 18, borderTopWidth: 3, borderRightWidth: 3 },
  bl: { bottom: 18, left: 18, borderBottomWidth: 3, borderLeftWidth: 3 },
  br: { bottom: 18, right: 18, borderBottomWidth: 3, borderRightWidth: 3 },
} as const;

const styles = StyleSheet.create({
  viewfinderWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "flex-start",
    paddingTop: 16,
    gap: 18,
  },
  viewfinder: {
    width: 300,
    height: 300,
    borderRadius: 20,
    backgroundColor: "#111",
    overflow: "hidden",
  },
  corner: {
    position: "absolute",
    width: 28,
    height: 28,
    borderRadius: 6,
    borderColor: "#fff",
  },
  hint: {
    fontSize: 14,
    color: T.textMuted,
    textAlign: "center",
    maxWidth: 280,
    lineHeight: 21,
    fontFamily: T.font,
  },
  permissionBlock: {
    paddingHorizontal: 24,
    paddingVertical: 40,
    gap: 12,
    alignItems: "center",
  },
  permissionTitle: {
    fontSize: 20,
    fontWeight: "600",
    color: T.text,
    fontFamily: T.font,
  },
  permissionBody: {
    fontSize: 15,
    color: T.textMuted,
    textAlign: "center",
    marginBottom: 16,
    fontFamily: T.font,
  },
  centerBlock: {
    paddingVertical: 40,
    paddingHorizontal: 24,
    alignItems: "center",
    gap: 14,
  },
  stepTitle: {
    fontSize: 22,
    fontWeight: "600",
    color: T.text,
    fontFamily: T.font,
  },
  stepSub: {
    fontSize: 15,
    color: T.textMuted,
    textAlign: "center",
    maxWidth: 320,
    lineHeight: 22,
    fontFamily: T.font,
  },
  iconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  iconText: { fontSize: 30, fontWeight: "600" },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: "rgba(60,60,67,0.3)",
    alignItems: "center",
    justifyContent: "center",
  },
  radioSelected: { borderColor: T.primary },
  radioInner: {
    width: 11,
    height: 11,
    borderRadius: 6,
    backgroundColor: T.primary,
  },
});
