import type { ImageSourcePropType } from 'react-native';

// Portraits du répertoire Wake et photo de profil publique de NLR.
const portraits: Record<string, ImageSourcePropType | undefined> = {
  'atelier-jeu': require('../../assets/chat-profiles/atelier-jeu.jpg'),
  'carnet-sextant': require('../../assets/chat-profiles/carnet-sextant.jpg'),
  'coach-colony-2': require('../../assets/chat-profiles/coach-colony-2.jpg'),
  'coach-colony-3': require('../../assets/chat-profiles/coach-colony-3.jpg'),
  'coach-colony-4': require('../../assets/chat-profiles/coach-colony-4.jpg'),
  'coach-colony-5': require('../../assets/chat-profiles/coach-colony-5.jpg'),
  'coach-colony-6': require('../../assets/chat-profiles/coach-colony-6.jpg'),
  'coach-colony-7': require('../../assets/chat-profiles/coach-colony-7.jpg'),
  'coach-colony-8': require('../../assets/chat-profiles/coach-colony-8.jpg'),
  'coach-colony': require('../../assets/chat-profiles/coach-colony.jpg'),
  'coach-des-coachs': require('../../assets/chat-profiles/coach-des-coachs.jpg'),
  'coach-integrateur': require('../../assets/chat-profiles/coach-integrateur.jpg'),
  'coach-telegram-10': require('../../assets/chat-profiles/coach-telegram-10.jpg'),
  'coach-telegram-11': require('../../assets/chat-profiles/coach-telegram-11.jpg'),
  'coach-telegram-12': require('../../assets/chat-profiles/coach-telegram-12.jpg'),
  'coach-telegram-13': require('../../assets/chat-profiles/coach-telegram-13.jpg'),
  'coach-telegram-14': require('../../assets/chat-profiles/coach-telegram-14.jpg'),
  'coach-telegram-15': require('../../assets/chat-profiles/coach-telegram-15.jpg'),
  'coach-telegram-2': require('../../assets/chat-profiles/coach-telegram-2.jpg'),
  'coach-telegram-3': require('../../assets/chat-profiles/coach-telegram-3.jpg'),
  'coach-telegram-4': require('../../assets/chat-profiles/coach-telegram-4.jpg'),
  'coach-telegram-5': require('../../assets/chat-profiles/coach-telegram-5.jpg'),
  'coach-telegram-6': require('../../assets/chat-profiles/coach-telegram-6.jpg'),
  'coach-telegram-7': require('../../assets/chat-profiles/coach-telegram-7.jpg'),
  'coach-telegram-8': require('../../assets/chat-profiles/coach-telegram-8.jpg'),
  'coach-telegram-9': require('../../assets/chat-profiles/coach-telegram-9.jpg'),
  'coach-telegram': require('../../assets/chat-profiles/coach-telegram.jpg'),
  'crypto': require('../../assets/chat-profiles/crypto.jpg'),
  'equerre': require('../../assets/chat-profiles/equerre.jpg'),
  'marco': require('../../assets/chat-profiles/marco.jpg'),
  'medicis': require('../../assets/chat-profiles/medicis.jpg'),
  'nlr': require('../../assets/chat-profiles/nlr.jpg'),
  'pattern-holder': require('../../assets/chat-profiles/pattern-holder.jpg'),
  'reveilleur': require('../../assets/chat-profiles/reveilleur.jpg'),
  'room-coach-civ': require('../../assets/chat-profiles/room-coach-civ.jpg'),
  'room-equerre': require('../../assets/chat-profiles/room-equerre.jpg'),
  'room-la-toile': require('../../assets/chat-profiles/room-la-toile.jpg'),
  'room-medicis': require('../../assets/chat-profiles/room-medicis.jpg'),
  'room-rose-des-vents': require('../../assets/chat-profiles/room-rose-des-vents.jpg'),
  'selection': require('../../assets/chat-profiles/selection.jpg'),
  'veille-chaine': require('../../assets/chat-profiles/veille-chaine.jpg'),
  'veille-reseaux': require('../../assets/chat-profiles/veille-reseaux.jpg'),
  'viz': require('../../assets/chat-profiles/viz.jpg'),
  'vox-holder': require('../../assets/chat-profiles/vox-holder.jpg'),
  'vox': require('../../assets/chat-profiles/vox.jpg'),
};

const names: Record<string, string | undefined> = {
  'mind': 'marco',
  'l-integrateur': 'coach-integrateur',
  'la-toile': 'room-la-toile',
  'zenith': 'coach-colony',
  'meridien': 'coach-colony-2',
  'solstice': 'coach-colony-3',
  'equinoxe': 'coach-colony-4',
  'horizon': 'coach-colony-5',
  'prisme': 'coach-colony-6',
  'celeste': 'coach-colony-7',
  'astrolabe': 'coach-colony-8',
  'medicis': 'room-medicis',
  'medicis-decideur': 'medicis',
  'gardien-de-l-atelier': 'atelier-jeu',
  'equerre': 'room-equerre',
  'compas': 'equerre',
  'rose-des-vents': 'room-rose-des-vents',
  'orion': 'coach-telegram',
  'vega': 'coach-telegram-2',
  'altair': 'coach-telegram-3',
  'sirius': 'coach-telegram-4',
  'rigel': 'coach-telegram-5',
  'aldebaran': 'coach-telegram-6',
  'polaris': 'coach-telegram-7',
  'deneb': 'coach-telegram-8',
  'capella': 'coach-telegram-9',
  'arcturus': 'coach-telegram-10',
  'betelgeuse': 'coach-telegram-11',
  'antares': 'coach-telegram-12',
  'canopus': 'coach-telegram-13',
  'fomalhaut': 'coach-telegram-14',
  'spica': 'coach-telegram-15',
  'gardien-de-vox': 'vox-holder',
  'coach-civ': 'room-coach-civ',
  'carnet': 'carnet-sextant',
};

export function profilePicture(name: string, mine: boolean, handle?: string) {
  if (mine) return portraits.nlr;
  if (handle && Object.hasOwn(portraits, handle)) return portraits[handle];
  const label = name.replace(/^Room \d+\s*·\s*/i, '').split(' · ')[0]
    .replace(/\s*\((?:Room \d+|fil principal)\)\s*$/i, '');
  const key = label.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const slug = Object.hasOwn(names, key) ? names[key]! : key;
  return Object.hasOwn(portraits, slug) ? portraits[slug] : undefined;
}
