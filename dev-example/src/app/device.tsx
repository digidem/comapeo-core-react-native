import { Stack } from "expo-router";
import { useEffect, useState } from "react";
import { Platform, View } from "react-native";

import { FormField } from "@/components/FormField";
import { HeaderButton } from "@/components/HeaderButton";
import { PrimaryButton } from "@/components/PrimaryButton";
import { Screen } from "@/components/Screen";
import { Section } from "@/components/Section";
import { ShortId } from "@/components/ShortId";
import { fmtDateTime, shortId } from "@/lib/format";
import {
  useIsArchiveDevice,
  useOwnDeviceInfo,
  useSetIsArchiveDevice,
  useSetOwnDeviceInfo,
} from "@comapeo/core-react";

export default function DeviceScreen() {
  const { data: device } = useOwnDeviceInfo();
  const { data: isArchive } = useIsArchiveDevice();
  const setDevice = useSetOwnDeviceInfo();
  const setArchive = useSetIsArchiveDevice();

  const [name, setName] = useState(device.name ?? "");
  useEffect(() => setName(device.name ?? ""), [device.name]);

  const isPending = setDevice.status === "pending";

  const save = () => {
    const next = name.trim();
    if (!next) return;
    setDevice.mutate({ name: next, deviceType: device.deviceType });
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: "This device",
          headerRight: () =>
            Platform.OS === "ios" ? (
              <HeaderButton
                label={isPending ? "Saving…" : "Save"}
                onPress={save}
              />
            ) : undefined,
        }}
      />
      <Screen>
        <Section header="Identity">
          <FormField
            label="name"
            value={name}
            onChangeText={setName}
            placeholder="Device name"
          />
          <FormField label="deviceType" value={device.deviceType} readOnly />
          <FormField
            label="deviceId"
            value={shortId(device.deviceId)}
            readOnly
            right={<ShortId id={device.deviceId} size="xs" />}
            isLast
          />
        </Section>
        <Section header="Archive device">
          <FormField
            label="isArchiveDevice"
            value={String(isArchive)}
            readOnly
            right={
              <PrimaryButton
                style={{ minHeight: 32, paddingVertical: 6 }}
                onPress={() =>
                  setArchive.mutate({ isArchiveDevice: !isArchive })
                }
              >
                {isArchive ? "Unset" : "Set"}
              </PrimaryButton>
            }
            isLast
          />
        </Section>
        {Platform.OS !== "ios" ? (
          <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
            <PrimaryButton onPress={save} disabled={isPending}>
              {isPending ? "Saving…" : "Save device info"}
            </PrimaryButton>
          </View>
        ) : null}
      </Screen>
    </>
  );
}
