// Neutral productivity palette aligned with the app's calendar reference.
// Legacy key names remain temporarily so existing screens migrate without a
// disruptive data or component rewrite.
export const Colors = {
  appBg:      '#F2F3F5',
  body:       '#FFFFFF',
  card:       '#FFFFFF',
  inputBg:    '#F2F3F5',
  tasksBg:    '#F2F3F5',
  waveformBg: '#F2F3F5',

  loginTop:   '#FFFFFF',
  loginBot:   '#F2F3F5',

  logoFrom:   '#5083FB',
  logoTo:     '#1456F0',

  primary:    '#1456F0',
  primaryHover: '#336DF4',
  primaryPressed: '#0C4CD3',
  primaryLight: '#F0F4FF',
  purple:     '#1456F0',
  purpleDark: '#0C4CD3',
  gradFrom:   '#336DF4',
  gradTo:     '#1456F0',
  purpleLight:'#F0F4FF',

  text:       '#1F2329',
  sub:        '#646A73',
  faint:      '#8F959E',
  disabled:   '#BBBFC4',
  pressed:    'rgba(31,35,41,0.12)',

  green:      '#258832',
  orange:     '#C25705',
  blue:       '#336DF4',
  pink:       '#D1498B',
  pinkBorder: '#DEE0E3',
  red:        '#E22E28',
  teal:       '#168F9D',

  border:     '#DEE0E3',
  divider:    'rgba(31,35,41,0.15)',
  overlay:    'rgba(31,35,41,0.30)',
} as const;

export type ColorKey = keyof typeof Colors;

export const Radius = {
  xs: 4,
  sm: 6,
  md: 8,
  lg: 12,
  full: 999,
} as const;

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

export const Motion = {
  fast: 120,
  standard: 180,
  panel: 240,
} as const;
