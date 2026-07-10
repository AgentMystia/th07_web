import { TH07_DATA } from '../data/th07-data';
import { Anm } from '../formats/anm';

export type AnmKey = keyof typeof TH07_DATA.anm;

export interface GameAssets {
  anms: Record<AnmKey, Anm>;
  images: Record<string, HTMLImageElement>;
}

// Images extracted from the ANM entries (thanm -x 7), flattened by basename,
// plus the JPEG menu backdrops shipped directly inside Th07.dat.
const IMAGE_FILES: Record<string, string> = {
  etama: 'assets/th07-img/etama.png',
  etama2: 'assets/th07-img/etama2.png',
  etama3: 'assets/th07-img/etama3.png',
  etama4: 'assets/th07-img/etama4.png',
  stg1enm: 'assets/th07-img/stg1enm.png',
  stg1bg: 'assets/th07-img/stg1bg.png',
  stg2enm: 'assets/th07-img/stg2enm.png',
  stg2bg: 'assets/th07-img/stg2bg.png',
  stg3enm: 'assets/th07-img/stg3enm.png',
  stg3bg: 'assets/th07-img/stg3bg.png',
  stg4enm: 'assets/th07-img/stg4enm.png',
  stg4bg: 'assets/th07-img/stg4bg.png',
  stg4bg2: 'assets/th07-img/stg4bg2.png',
  stg4bg3: 'assets/th07-img/stg4bg3.png',
  stg4bg4: 'assets/th07-img/stg4bg4.png',
  stg4bg5: 'assets/th07-img/stg4bg5.png',
  stg5enm: 'assets/th07-img/stg5enm.png',
  stg5bg: 'assets/th07-img/stg5bg.png',
  stg6enm: 'assets/th07-img/stg6enm.png',
  stg6enm2: 'assets/th07-img/stg6enm2.png',
  stg6bg: 'assets/th07-img/stg6bg.png',
  stg6bg2: 'assets/th07-img/stg6bg2.png',
  stg7enm: 'assets/th07-img/stg7enm.png',
  stg7bg: 'assets/th07-img/stg7bg.png',
  stg8enm: 'assets/th07-img/stg8enm.png',
  stg8bg: 'assets/th07-img/stg8bg.png',
  eff02: 'assets/th07-img/eff02.png',
  eff03: 'assets/th07-img/eff03.png',
  eff04: 'assets/th07-img/eff04.png',
  eff04b: 'assets/th07-img/eff04b.png',
  eff05: 'assets/th07-img/eff05.png',
  eff05b: 'assets/th07-img/eff05b.png',
  eff06: 'assets/th07-img/eff06.png',
  eff06b: 'assets/th07-img/eff06b.png',
  eff07b: 'assets/th07-img/eff07b.png',
  eff07c: 'assets/th07-img/eff07c.png',
  eff08: 'assets/th07-img/eff08.png',
  eff08b: 'assets/th07-img/eff08b.png',
  std2txt: 'assets/th07-img/std2txt.png',
  std3txt: 'assets/th07-img/std3txt.png',
  std4txt: 'assets/th07-img/std4txt.png',
  std5txt: 'assets/th07-img/std5txt.png',
  std6txt: 'assets/th07-img/std6txt.png',
  std7txt: 'assets/th07-img/std7txt.png',
  std8txt: 'assets/th07-img/std8txt.png',
  face_02_00: 'assets/th07-img/face_02_00.png',
  face_03_00: 'assets/th07-img/face_03_00.png',
  face_04_00: 'assets/th07-img/face_04_00.png',
  face_04_01: 'assets/th07-img/face_04_01.png',
  face_04_02: 'assets/th07-img/face_04_02.png',
  face_05_00: 'assets/th07-img/face_05_00.png',
  face_05_01: 'assets/th07-img/face_05_01.png',
  face_06_00: 'assets/th07-img/face_06_00.png',
  face_06_01: 'assets/th07-img/face_06_01.png',
  face_07_01: 'assets/th07-img/face_07_01.png',
  face_07_02: 'assets/th07-img/face_07_02.png',
  face_08_00: 'assets/th07-img/face_08_00.png',
  face_08_01: 'assets/th07-img/face_08_01.png',
  face_08_02: 'assets/th07-img/face_08_02.png',
  player00: 'assets/th07-img/player00.png',
  player01: 'assets/th07-img/player01.png',
  player02: 'assets/th07-img/player02.png',
  eff01: 'assets/th07-img/eff01.png',
  ascii: 'assets/th07-img/ascii.png',
  asciis: 'assets/th07-img/asciis.png',
  pause: 'assets/th07-img/pause.png',
  title01: 'assets/th07-img/title01.png',
  title02: 'assets/th07-img/title02.png',
  select01: 'assets/th07-img/select01.png',
  select02: 'assets/th07-img/select02.png',
  sl_pl00: 'assets/th07-img/sl_pl00.png',
  sl_pl01: 'assets/th07-img/sl_pl01.png',
  sl_pl02: 'assets/th07-img/sl_pl02.png',
  sl_pltx: 'assets/th07-img/sl_pltx.png',
  sl_text: 'assets/th07-img/sl_text.png',
  replay00: 'assets/th07-img/replay00.png',
  std1txt: 'assets/th07-img/std1txt.png',
  face_01_00: 'assets/th07-img/face_01_00.png',
  face_rm00: 'assets/th07-img/face_rm00.png',
  face_rm01: 'assets/th07-img/face_rm01.png',
  face_mr00: 'assets/th07-img/face_mr00.png',
  face_mr01: 'assets/th07-img/face_mr01.png',
  face_sk00: 'assets/th07-img/face_sk00.png',
  face_sk01: 'assets/th07-img/face_sk01.png',
  front: 'assets/th07-img/front.png',
  ename: 'assets/th07-img/ename.png',
  loading: 'assets/th07-img/loading.png',
  title00: 'assets/th07-img/title00.jpg',
  select00: 'assets/th07-img/select00.jpg',
  th07logo: 'assets/th07-img/th07logo.jpg'
};

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load image ${src}`));
    img.src = src;
  });
}

export async function loadAssets(): Promise<GameAssets> {
  const anms = Object.fromEntries(
    Object.entries(TH07_DATA.anm).map(([key, b64]) => [key, new Anm(b64 as string, key)])
  ) as Record<AnmKey, Anm>;
  const images: Record<string, HTMLImageElement> = {};
  await Promise.all(
    Object.entries(IMAGE_FILES).map(async ([key, src]) => {
      images[key] = await loadImage(src);
    })
  );
  return { anms, images };
}
