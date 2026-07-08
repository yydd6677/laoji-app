// Design tokens extracted from Figma Make / design images
export const Colors = {
  appBg:      '#FFF5F8',
  card:       '#FFFFFF',
  inputBg:    '#F0ECFF',
  tasksBg:    '#FFF0F8',
  waveformBg: '#F4F0FF',

  loginTop:   '#F7EFFE',
  loginBot:   '#FFF3FA',

  logoFrom:   '#CEAAF5',
  logoTo:     '#F0BEE0',

  purple:     '#7B5CB8',
  purpleDark: '#2E1880',
  gradFrom:   '#9268E0',
  gradTo:     '#6A38B2',
  purpleLight:'#EDE8FF',

  text:       '#1C1B33',
  sub:        '#9490B5',
  faint:      '#B8B4D4',

  green:      '#52C41A',
  orange:     '#FF9500',
  blue:       '#5B8CFF',
  pink:       '#FF8FAB',
  pinkBorder: '#FFB5CC',
  red:        '#FF4D4F',
  teal:       '#26C6DA',

  border:     'rgba(150,100,200,0.1)',
} as const;

export type ColorKey = keyof typeof Colors;
