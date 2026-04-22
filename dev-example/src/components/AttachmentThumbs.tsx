import { StyleSheet, Text, View } from 'react-native';

type Attachment = { type?: string };

type Props = { attachments?: readonly Attachment[] };

const ICON: Record<string, string> = {
  photo: '📷',
  audio: '🎙',
  video: '🎞',
};

export function AttachmentThumbs({ attachments = [] }: Props) {
  if (!attachments.length) return null;
  const visible = attachments.slice(0, 3);
  const overflow = attachments.length - visible.length;
  return (
    <View style={styles.row}>
      {visible.map((a, i) => (
        <View key={i} style={styles.thumb}>
          <Text style={styles.icon}>{ICON[a.type ?? ''] ?? '📎'}</Text>
        </View>
      ))}
      {overflow > 0 ? <Text style={styles.more}>+{overflow}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  thumb: {
    width: 22,
    height: 22,
    borderRadius: 4,
    backgroundColor: '#e5e7eb',
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon: { fontSize: 11 },
  more: { fontSize: 11, color: '#6b7280' },
});
