import { Stack } from "expo-router";
import { Platform, StyleSheet, Text, View } from "react-native";

import { EmptyState } from "@/components/EmptyState";
import { Glyph } from "@/components/Glyph";
import { Screen } from "@/components/Screen";
import { Section } from "@/components/Section";
import { ShortId } from "@/components/ShortId";
import { StatusChip } from "@/components/StatusChip";
import { T } from "@/lib/theme";
import { useManyReceivedMapShares } from "@comapeo/core-react";

// NOTE: Map server is not yet wired up in comapeo-core-react-native, so this
// list will likely be empty (or return an error toast). The screen exists to
// demonstrate where map-share state would render once the server lands.

export default function MapSharesScreen() {
  const received = useManyReceivedMapShares();

  return (
    <>
      <Stack.Screen options={{ title: "Map shares" }} />
      <Screen>
        <Section header="Received">
          {received.length === 0 ? (
            <EmptyState
              title="No shared maps"
              icon="▦"
              action={
                <Text style={styles.hint}>
                  Map server is not yet wired up in this build.
                </Text>
              }
            />
          ) : (
            received.map((s, i) => {
              const isLast = i === received.length - 1;
              return (
                <View
                  key={s.shareId}
                  style={[
                    styles.row,
                    !isLast && {
                      borderBottomColor: T.separator,
                      borderBottomWidth: T.separatorWidth,
                    },
                  ]}
                >
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 10,
                    }}
                  >
                    <Glyph
                      bg="#475569"
                      ch="▦"
                      size={Platform.OS === "ios" ? 34 : 40}
                      radius={Platform.OS === "ios" ? 8 : 20}
                    />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.title}>
                        {s.mapName ?? "(unnamed map)"}
                      </Text>
                      <ShortId id={s.shareId} size="xs" />
                    </View>
                    <StatusChip
                      label={s.status}
                      tone={
                        s.status === "completed"
                          ? "success"
                          : s.status === "downloading"
                            ? "info"
                            : s.status === "error"
                              ? "danger"
                              : "warning"
                      }
                    />
                  </View>
                </View>
              );
            })
          )}
        </Section>
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: 16,
    paddingVertical: Platform.select({ ios: 12, default: 14 }),
  },
  title: { fontSize: 16, fontWeight: "500", color: T.text, fontFamily: T.font },
  hint: {
    color: T.textMuted,
    fontSize: 13,
    paddingHorizontal: 24,
    textAlign: "center",
    fontStyle: "italic",
  },
});
