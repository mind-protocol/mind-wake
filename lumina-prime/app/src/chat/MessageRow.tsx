import React from 'react';
import { Image, View } from 'react-native';
import { profilePicture } from './profilePictures';

const size = 32;

export function MessageRow({ name, mine = false, handle, children }: {
  name: string; mine?: boolean; handle?: string; children: React.ReactNode;
}) {
  const picture = profilePicture(name, mine, handle);
  return <View style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '95%',
    flexDirection: mine ? 'row-reverse' : 'row', alignItems: 'flex-end', gap: 6 }}>
    {picture && <Image aria-hidden source={picture} resizeMode="cover"
      style={{ width: size, height: size, borderRadius: size / 2 }} />}
    <View style={{ flexShrink: 1, minWidth: 0, gap: 2 }}>{children}</View>
  </View>;
}
