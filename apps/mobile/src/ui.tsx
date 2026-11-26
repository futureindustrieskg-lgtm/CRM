/** Общие элементы интерфейса: цвета светлой/тёмной темы, карточка, кнопка, состояние загрузки. */
import { ReactNode } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextStyle, useColorScheme, View, ViewStyle } from 'react-native';
import { useI18n } from './i18n';

const light = {
  bg: '#f4f6fb',
  card: '#ffffff',
  text: '#111827',
  muted: '#6b7280',
  border: '#e5e7eb',
  primary: '#1d4ed8',
  onPrimary: '#ffffff',
  danger: '#b91c1c',
  ok: '#047857',
  warn: '#b45309',
  chip: '#eef2ff',
};
const dark: typeof light = {
  bg: '#0b1020',
  card: '#151b2e',
  text: '#e5e7eb',
  muted: '#9ca3af',
  border: '#263049',
  primary: '#60a5fa',
  onPrimary: '#0b1020',
  danger: '#f87171',
  ok: '#34d399',
  warn: '#fbbf24',
  chip: '#1e293b',
};
export type Colors = typeof light;
export const useColors = () => (useColorScheme() === 'dark' ? dark : light);

export function Screen({ children, refreshing, onRefresh }: { children: ReactNode; refreshing?: boolean; onRefresh?: () => void }) {
  const c = useColors();
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.bg }}
      contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 12 }}
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} /> : undefined}
    >
      {children}
    </ScrollView>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const c = useColors();
  return <View style={[{ backgroundColor: c.card, borderRadius: 12, padding: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, gap: 6 }, style]}>{children}</View>;
}

export function T({
  children,
  muted,
  bold,
  size,
  color,
  style,
  numberOfLines,
}: {
  children: ReactNode;
  muted?: boolean;
  bold?: boolean;
  size?: number;
  color?: string;
  style?: TextStyle;
  numberOfLines?: number;
}) {
  const c = useColors();
  return (
    <Text numberOfLines={numberOfLines} style={[{ color: color ?? (muted ? c.muted : c.text), fontSize: size ?? 15, fontWeight: bold ? '700' : '400' }, style]}>
      {children}
    </Text>
  );
}

export function Title({ children }: { children: ReactNode }) {
  return (
    <T bold size={18}>
      {children}
    </T>
  );
}

export function Button({
  title,
  onPress,
  kind = 'primary',
  disabled,
  small,
}: {
  title: string;
  onPress: () => void;
  kind?: 'primary' | 'plain' | 'danger';
  disabled?: boolean;
  small?: boolean;
}) {
  const c = useColors();
  const bg = kind === 'primary' ? c.primary : 'transparent';
  const fg = kind === 'primary' ? c.onPrimary : kind === 'danger' ? c.danger : c.primary;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => ({
        backgroundColor: bg,
        borderColor: kind === 'primary' ? bg : c.border,
        borderWidth: 1,
        borderRadius: 10,
        paddingVertical: small ? 6 : 12,
        paddingHorizontal: small ? 10 : 16,
        alignItems: 'center',
        opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
      })}
    >
      <Text style={{ color: fg, fontWeight: '600', fontSize: small ? 13 : 15 }}>{title}</Text>
    </Pressable>
  );
}

export function Chip({ label, color }: { label: string; color?: string }) {
  const c = useColors();
  return (
    <View style={{ backgroundColor: c.chip, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, alignSelf: 'flex-start' }}>
      <Text style={{ color: color ?? c.text, fontSize: 12 }}>{label}</Text>
    </View>
  );
}

export function Loading() {
  const { t } = useI18n();
  const c = useColors();
  return (
    <View style={{ padding: 24, alignItems: 'center', gap: 8 }}>
      <ActivityIndicator color={c.primary} />
      <T muted>{t('loading')}</T>
    </View>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useI18n();
  const c = useColors();
  if (!error) return null;
  return (
    <Card style={{ borderColor: c.danger }}>
      <T color={c.danger}>{error instanceof Error ? error.message : String(error)}</T>
      {onRetry && <Button small kind="plain" title={t('retry')} onPress={onRetry} />}
    </Card>
  );
}

export function Row({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }, style]}>{children}</View>;
}
