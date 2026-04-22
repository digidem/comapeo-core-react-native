import { StyleSheet, Text } from 'react-native';

import { T } from '@/lib/theme';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const TONES: Record<Tone, { bg: string; fg: string }> = {
  neutral: { bg: 'rgba(0,0,0,0.06)', fg: 'rgba(0,0,0,0.62)' },
  success: { bg: 'rgba(5,150,105,0.12)', fg: '#047857' },
  warning: { bg: 'rgba(217,119,6,0.12)', fg: '#B45309' },
  danger: { bg: 'rgba(220,38,38,0.12)', fg: '#B91C1C' },
  info: { bg: 'rgba(14,107,82,0.12)', fg: '#0E6B52' },
};

type Props = {
  label: string;
  tone?: Tone;
};

export function StatusChip({ label, tone = 'neutral' }: Props) {
  const t = TONES[tone];
  return (
    <Text style={[styles.chip, { backgroundColor: t.bg, color: t.fg }]}>
      {label.toUpperCase()}
    </Text>
  );
}

const styles = StyleSheet.create({
  chip: {
    fontSize: 11,
    fontWeight: '600',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
    letterSpacing: 0.2,
    fontFamily: T.font,
    alignSelf: 'flex-start',
  },
});
