const paths = {
  home: '<path d="m3 10 9-7 9 7v9a2 2 0 0 1-2 2h-4v-7H9v7H5a2 2 0 0 1-2-2Z"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8Z"/><path d="M8 11h8M8 15h4"/>',
  memory: '<path d="M6 3h11a2 2 0 0 1 2 2v16H6a3 3 0 0 1 0-6h13M3 18V6a3 3 0 0 1 3-3"/><path d="M8 7h7M8 11h4"/>',
  plug: '<path d="m12 12 5-5M7 3l5 5-4 4-5-5M16 12l5 5-4 4-5-5M3 21l5-5M16 8l5-5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-3.7 1.6 1.6 0 0 1 1-2.9h2a4 4 0 0 0 4-4A8.4 8.4 0 0 0 12 3Z"/><circle cx="7.5" cy="9" r=".6"/><circle cx="12" cy="6.8" r=".6"/><circle cx="16.5" cy="9" r=".6"/><circle cx="6.5" cy="14" r=".6"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  moon: '<path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z"/>',
  monitor: '<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8m-4-5v5"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
  spark: '<path d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6Z"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  download: '<path d="M12 3v13m-5-5 5 5 5-5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8m-8 4h5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  leaf: '<path d="M20 3c-9 0-16 3-16 10a6 6 0 0 0 6 6c7 0 10-7 10-16Z"/><path d="M4 21 15 10"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  sliders: '<path d="M4 6h6m4 0h6M4 12h10m4 0h2M4 18h2m4 0h10"/><circle cx="12" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m21 16-6-6L3 21"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  edit: '<path d="m16 3 5 5L8 21H3v-5Z"/><path d="m13 6 5 5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v.01"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  bag: '<path d="M5 7h14l2 14H3Z"/><path d="M8 8V6a4 4 0 0 1 8 0v2M8 13c0 5 8 5 8 0"/>',
  pin: '<path d="m16 3 5 5-4 3-1 5-3 1-6-6 1-3Z"/><path d="m11 15-8 6"/>',
  award: '<circle cx="12" cy="8" r="5"/><path d="m8 12-2 9 6-3 6 3-2-9"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 6a8 8 0 0 1 13 3M5 15a8 8 0 0 0 13 3"/>',
  activity: '<path d="M2 12h4l3-8 6 16 3-8h4"/>',
  wallet: '<path d="M20 7V4H6a3 3 0 0 0 0 6h15v10H6a3 3 0 0 1-3-3V7"/><path d="M21 13h-5v4h5"/>',
  cpu: '<rect x="5" y="5" width="14" height="14" rx="3"/><path d="M9 1v4m6-4v4m4 4h4m-4 6h4M9 19v4m6-4v4M1 9h4m-4 6h4"/><rect x="9" y="9" width="6" height="6" rx="1"/>',
  play: '<path d="m8 4 12 8-12 8Z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4m0 4v.01"/>',
  external: '<path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
  settings: '<path d="m10 2-1 3-3 1-3-1-2 4 3 2v3l-2 2 2 4 3-1 3 1 1 3h4l1-3 3-1 3 1 2-4-3-2v-3l2-2-2-4-3 1-3-1-1-3Z" transform="translate(0 -1) scale(.95)"/><circle cx="12" cy="12" r="3"/>',
};

export function icon(name, className = '') {
  return `<svg class="icon ${className}" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name] || paths.spark}</svg>`;
}

export function brandMark(brand = 'coffeenator') {
  const shapes = {
    coffeenator: '<path d="M10 21h23v10a9 9 0 0 1-9 9h-5a9 9 0 0 1-9-9Z" fill="currentColor"/><path d="M33 24h3a5 5 0 0 1 0 10h-4M18 7c-4 5 4 5 0 9m9-9c-4 5 4 5 0 9" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M16 29h2m8 0h2m-9 5q3 3 6 0" stroke="var(--logo-face, #805039)" stroke-width="2" fill="none" stroke-linecap="round"/>',
    carrynest: '<path d="M8 20c0 18 32 18 32 0M13 21c0 12 22 12 22 0M18 22c0 6 12 6 12 0" stroke="currentColor" stroke-width="3.5" fill="none" stroke-linecap="round"/><circle cx="24" cy="13" r="5" fill="currentColor"/>',
    kithlane: '<path d="M13 37V12a4 4 0 0 1 8 0v7l14-12M21 24l15 14M13 24l16-13" stroke="currentColor" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  };
  return `<svg class="brand-mark" viewBox="0 0 48 48" aria-hidden="true" focusable="false">${shapes[brand] || shapes.coffeenator}</svg>`;
}

export function serviceMark(name, dark = false) {
  const assets = { gmail: 'gmail.png', calendar: 'calendar.png', drive: 'drive.png', github: 'github.svg', supabase: 'supabase.svg', claude: 'claude.svg', chatgpt: 'chatgpt.svg', composio: `composio-${dark ? 'white' : 'black'}.svg` };
  if (assets[name]) return `<img class="service-mark${name === 'github' && dark ? ' monochrome-light' : ''}" src="/icons/${assets[name]}" width="24" height="24" alt="" aria-hidden="true">`;
  if (name === 'notion') return '<svg class="service-mark" viewBox="0 0 42 42" aria-hidden="true" focusable="false"><rect x="5" y="5" width="30" height="30" rx="5" fill="currentColor"/><text x="20" y="29" fill="var(--surface)" text-anchor="middle" font-family="Georgia,serif" font-size="27" font-weight="700">N</text></svg>';
  return icon('cpu');
}

export function companionArt(kind = 'bean', accessory = 'none') {
  if (kind === 'none') return `<div class="no-companion-art">${icon('spark')}</div>`;
  const extras = accessory === 'leaf' ? '<path d="M118 43c-6-18 6-28 23-24-1 15-9 25-23 24Z" fill="#79944f"/><path d="m117 44 14-16" stroke="#526d34" stroke-width="2" fill="none"/>' : accessory === 'scarf' ? '<path d="M69 144q51 19 102 0l-3 16q-48 16-96-1Z" fill="#dd925f"/><path d="m149 155 3 32 14-6-3-29Z" fill="#cd8052"/>' : '';
  const shapes = {
    bean: '<ellipse cx="121" cy="186" rx="70" ry="9" fill="#513a27" opacity=".1"/><path class="bean-steam" d="M104 56c-19-17 16-21 0-41" stroke="#bba184" stroke-width="5" fill="none" stroke-linecap="round"/><path class="bean-steam second" d="M136 55c-18-17 16-21 0-41" stroke="#bba184" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M176 86h14c29 0 28 51-4 53h-13" stroke="#b7895f" stroke-width="15" fill="none"/><path d="M64 79h115l-7 65c-2 26-22 39-51 39s-50-13-52-39Z" fill="#c59b71"/><path d="M72 85h97l-6 56c-2 20-17 33-42 33s-42-13-44-33Z" fill="#e2bf91"/><ellipse cx="121" cy="79" rx="57" ry="12" fill="#f3d9b4"/><ellipse cx="121" cy="79" rx="45" ry="7" fill="#6c4431"/><path d="M102 78c7-8 17 7 25 0s17-3 17-3" stroke="#d6b187" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M65 118c-17-11-23-5-19 7 3 9 14 10 22 10" fill="#c59b71"/><g class="bean-eyes"><ellipse cx="101" cy="116" rx="4.5" ry="6.5" fill="#513528"/><ellipse cx="144" cy="116" rx="4.5" ry="6.5" fill="#513528"/><circle cx="100" cy="114" r="1.5" fill="#fff8e8"/><circle cx="143" cy="114" r="1.5" fill="#fff8e8"/></g><path d="M113 132q9 10 18 0" stroke="#684432" stroke-width="3" fill="none" stroke-linecap="round"/><ellipse cx="86" cy="128" rx="8" ry="4" fill="#ce8b75" opacity=".5"/><ellipse cx="159" cy="128" rx="8" ry="4" fill="#ce8b75" opacity=".5"/><path d="m94 179-8 7m62-7 8 7" stroke="#8f6645" stroke-width="6" stroke-linecap="round"/>',
    pip: '<ellipse cx="121" cy="186" rx="62" ry="9" fill="#192e23" opacity=".08"/><path d="M58 128c-3-47 21-82 63-82s68 32 63 82c-3 34-28 55-63 55s-60-21-63-55Z" fill="var(--pet-body, #c7d9ba)"/><path d="M71 124c7-25 27-30 50-13 24-17 43-12 50 13 9 33-13 52-50 52s-60-19-50-52Z" fill="#f2f0db"/><path d="M62 111c-21 8-28 26-17 35 9 5 19-7 26-20M180 110c24 12 27 27 14 33-10 3-17-11-22-19" fill="var(--pet-wing, #9cb592)"/><ellipse cx="99" cy="107" rx="5" ry="8" fill="#2b3c30"/><ellipse cx="144" cy="107" rx="5" ry="8" fill="#2b3c30"/><circle cx="97.5" cy="104" r="1.7" fill="#fff"/><circle cx="142.5" cy="104" r="1.7" fill="#fff"/><path d="m113 119 8 8 8-8" fill="#c49a52"/><ellipse cx="84" cy="119" rx="8" ry="4" fill="#d59b82" opacity=".5"/><ellipse cx="160" cy="119" rx="8" ry="4" fill="#d59b82" opacity=".5"/><path d="m96 181-7 5m58-5 7 5" stroke="#718268" stroke-width="5" stroke-linecap="round"/>',
    fox: '<ellipse cx="121" cy="186" rx="67" ry="9" fill="#192e23" opacity=".08"/><path d="M176 130c45-38 61 26 23 44l-35-9Z" fill="#cc8e67"/><path d="M193 115c24-2 31 23 13 40l-16-12Z" fill="#f6ebd9"/><path d="m64 83 1-54 47 32M174 83l2-54-47 32" fill="#c88960"/><path d="m72 69 1-27 23 21m57 0 16-20-1 27" fill="#e9bda3"/><path d="M59 113c0-50 27-60 62-60s63 13 63 60c0 43-21 68-63 68s-62-25-62-68Z" fill="#dea377"/><path d="M69 108c17 0 38 12 52 27 15-15 35-27 52-27-1 40-19 65-52 65s-50-25-52-65Z" fill="#f8ecd9"/><ellipse cx="97" cy="105" rx="5" ry="7" fill="#49372e"/><ellipse cx="147" cy="105" rx="5" ry="7" fill="#49372e"/><path d="m114 132 7 7 7-7Z" fill="#49372e"/><path d="M121 139v6m-7-2q7 9 14 0" stroke="#49372e" stroke-width="2" fill="none" stroke-linecap="round"/>',
    sprout: '<ellipse cx="120" cy="185" rx="59" ry="8" fill="#243c28" opacity=".09"/><path d="M73 110h94l-11 58c-3 14-70 14-73 0Z" fill="#ce9877"/><rect x="65" y="104" width="110" height="19" rx="7" fill="#e2b092"/><g class="pet-leaves"><path d="M119 106V49" stroke="#557956" stroke-width="6" stroke-linecap="round"/><path d="M120 87c-42 2-66-20-56-43 32-7 57 10 56 43Z" fill="#91b58b"/><path d="M122 66c-6-35 20-55 48-47 0 31-16 50-48 47Z" fill="#638e66"/><path d="m78 54 41 32m4-23 31-31" stroke="#4d7351" stroke-width="2" fill="none"/></g><ellipse cx="102" cy="143" rx="4" ry="6" fill="#5e3f32"/><ellipse cx="140" cy="143" rx="4" ry="6" fill="#5e3f32"/><path d="M113 157q8 7 16 0" stroke="#5e3f32" stroke-width="3" fill="none" stroke-linecap="round"/>',
    pebble: '<ellipse cx="119" cy="183" rx="69" ry="9" fill="#263339" opacity=".1"/><path d="M49 145c-4-42 28-97 64-101 39-4 71 38 77 74 7 46-16 64-71 64-43 0-67-9-70-37Z" fill="#bbc6c9"/><path d="M69 112c6-24 25-45 48-47" stroke="#dce4e3" stroke-width="10" fill="none" stroke-linecap="round"/><ellipse cx="96" cy="125" rx="5" ry="6" fill="#37474b"/><ellipse cx="146" cy="125" rx="5" ry="6" fill="#37474b"/><path d="M110 145q11 8 22 0" stroke="#37474b" stroke-width="3" fill="none" stroke-linecap="round"/><path d="m173 49 3 9 9 3-9 3-3 9-3-9-9-3 9-3Z" fill="#cfb572"/>',
    cloud: '<ellipse cx="119" cy="176" rx="69" ry="9" fill="#365367" opacity=".08"/><circle cx="164" cy="64" r="27" fill="#ead396"/><path d="M63 147c-34-1-42-53-10-65 5-43 53-53 74-22 29-18 62 4 61 31 34 5 34 56 2 57Z" fill="#d6e6ef"/><path d="M61 91c1-19 15-29 31-28" stroke="#f2f8fa" stroke-width="8" fill="none" stroke-linecap="round"/><ellipse cx="99" cy="113" rx="4.5" ry="6" fill="#405b6b"/><ellipse cx="144" cy="113" rx="4.5" ry="6" fill="#405b6b"/><path d="M112 129q10 9 19 0" stroke="#405b6b" stroke-width="3" fill="none" stroke-linecap="round"/><ellipse cx="86" cy="126" rx="7" ry="3.5" fill="#d4b5b2"/><ellipse cx="158" cy="126" rx="7" ry="3.5" fill="#d4b5b2"/>',
    pixel: '<ellipse cx="120" cy="184" rx="64" ry="8" fill="#294640" opacity=".1"/><path d="M120 58V33" stroke="#537f70" stroke-width="5"/><circle class="bot-light" cx="120" cy="27" r="9" fill="#bfce80"/><rect x="50" y="100" width="18" height="40" rx="8" fill="#8ab5a1"/><rect x="172" y="100" width="18" height="40" rx="8" fill="#8ab5a1"/><rect x="63" y="58" width="113" height="116" rx="29" fill="#aacbb9"/><rect x="77" y="81" width="85" height="59" rx="17" fill="#34584d"/><path d="M94 104v10m49-10v10" stroke="#e0edb9" stroke-width="8" stroke-linecap="round"/><path d="M111 124h17" stroke="#e0edb9" stroke-width="4" stroke-linecap="round"/><circle cx="120" cy="157" r="5" fill="#e8d7b3"/><path d="m91 174-5 9m62-9 5 9" stroke="#759f8b" stroke-width="7" stroke-linecap="round"/>',
    luna: '<ellipse cx="119" cy="187" rx="60" ry="8" fill="#413729" opacity=".08"/><path d="M168 34C104 8 56 55 56 111c0 55 40 81 84 75 31-3 55-20 66-46-50 17-90-23-80-61 7-22 22-35 42-45Z" fill="#e7ce97"/><path d="M83 84c-10 22-9 44 2 62" stroke="#f5e6bc" stroke-width="8" fill="none" stroke-linecap="round"/><ellipse cx="96" cy="119" rx="4" ry="6" fill="#685333"/><ellipse cx="123" cy="132" rx="4" ry="6" fill="#685333"/><path d="M100 143q6 9 15 5" stroke="#685333" stroke-width="3" fill="none" stroke-linecap="round"/><g class="moon-stars" fill="#b4a8d5"><path d="m181 60 4 12 12 4-12 4-4 12-4-12-12-4 12-4Z"/><path d="m158 100 2 7 7 2-7 2-2 7-2-7-7-2 7-2Z"/></g>',
    orbit: '<ellipse cx="121" cy="183" rx="60" ry="8" fill="#192e23" opacity=".08"/><path d="M57 112c-3-40 24-65 61-65s70 22 69 65-27 64-66 64-62-24-64-64Z" fill="#c7c0e5"/><path d="M53 98c-49 23 2 75 104 43 83-27 52-62 17-54" stroke="#8f83ba" stroke-width="9" fill="none" stroke-linecap="round"/><ellipse cx="99" cy="100" rx="5" ry="7" fill="#443b62"/><ellipse cx="145" cy="100" rx="5" ry="7" fill="#443b62"/><path d="M113 121q9 9 17 0" stroke="#443b62" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="44" cy="65" r="6" fill="#d7bc79"/><path d="m188 34 3 8 8 3-8 3-3 8-3-8-8-3 8-3Z" fill="#c8ae6e"/>',
  };
  const resolved = Object.hasOwn(shapes, kind) ? kind : 'bean';
  return `<svg class="companion-art pet-${resolved}" viewBox="0 0 240 210" aria-hidden="true" focusable="false">${shapes[resolved]}${extras}</svg>`;
}
