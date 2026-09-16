/**
 * geocoder.ts
 *
 * Understands hand-typed Argentine addresses ("Roseti 253 caba",
 * "libertador 500, vte lopez", "Av. Cerviño 3417, C1425 Cdad. Autónoma de Buenos Aires")
 * and turns them into coordinates. Tuned for the Buenos Aires metro area (AMBA).
 *
 * Providers, in order:
 *   1. Georef (Datos Argentina) and USIG (Buenos Aires City), queried in parallel.
 *   2. Nominatim (OpenStreetMap), only when the first two find nothing.
 *
 * Nothing is stored: every lookup is made and forgotten.
 */

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export interface Point {
  lat: number;
  lon: number;
}

export type ProvinceId = '02' | '06';
export type PlaceKind = 'caba' | 'district' | 'locality' | 'province' | 'ambiguous';

export interface Place {
  kind: PlaceKind;
  province: ProvinceId | null;
  districts: string[];
  label: string;
  usigName: string;
  fromPostalCode?: boolean;
}

export interface ParsedAddress {
  input: string;
  valid: boolean;
  reason: 'too_short' | 'no_street' | null;
  /** Street and door number, as sent to the providers. */
  query: string;
  /** Alternative spellings tried when `query` finds nothing. */
  variants: string[];
  street: string;
  streetBase: string;
  number: string | null;
  intersection: boolean;
  missingNumber: boolean;
  place: Place | null;
  places: Place[];
  postalHint: string | null;
  unrecognized: string;
}

export type Source = 'Georef' | 'USIG' | 'OpenStreetMap';
export type CandidateKind = 'address' | 'intersection' | 'street' | 'area';

export interface Candidate {
  lat: number | null;
  lon: number | null;
  street: string;
  number: string | null;
  province: string | null;
  district: string;
  area: string;
  /** Street and number (or both streets of a corner). */
  via: string;
  label: string;
  source: Source;
  kind: CandidateKind;
}

export type LocatedCandidate = Candidate & Point;

export interface Match extends LocatedCandidate {
  sources: Source[];
  centerDistance: number;
}

export interface NumberRange {
  from: number;
  to: number;
}

export interface StreetInfo {
  street: string;
  province: string | null;
  district: string;
  area: string;
  range: NumberRange | null;
}

export interface Suggestion extends StreetInfo {
  /** Ready-to-search text, e.g. "Rosetti 253, Moreno". */
  text: string;
}

export interface KnownStreet {
  street: string;
  area: string;
  range: NumberRange | null;
  /** The provider knows the address but has no coordinates for it. */
  notOnMap: boolean;
}

interface ResultBase {
  notices: string[];
  parsed: ParsedAddress;
}

export type GeocodeResult =
  | (ResultBase & { status: 'ok'; match: Match; choices: Match[] })
  | (ResultBase & { status: 'choices'; match: null; choices: Match[] })
  | (ResultBase & {
      status: 'not_found';
      suggestions: Suggestion[];
      knownStreet: KnownStreet | null;
      usigMessage: string;
    })
  | (ResultBase & { status: 'invalid'; reason: ParsedAddress['reason'] })
  | (ResultBase & { status: 'error' });

export interface GeocodeOptions {
  signal?: AbortSignal;
  /** Where ambiguous results are ranked from (usually the centroid of the nodes). */
  center?: Point;
  /** Look for similar street names when nothing is found. */
  suggest?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

export const PROVIDERS = Object.freeze({
  georef: 'https://apis.datos.gob.ar/georef/api/v2.0',
  usig: 'https://servicios.usig.buenosaires.gob.ar/normalizar/',
  nominatim: 'https://nominatim.openstreetmap.org/search',
});

export const CABA_CENTER: Readonly<Point> = Object.freeze({ lat: -34.6118, lon: -58.4173 });

const REQUEST_TIMEOUT_MS = 8000;
const NOMINATIM_GAP_MS = 1100;
const AMBA_RADIUS_KM = 90;
const SAME_POINT_KM = 0.15;
const SAME_AREA_KM = 0.4;

/* -------------------------------------------------------------------------- */
/* Text helpers                                                                */
/* -------------------------------------------------------------------------- */

/** Lowercase and strip accents, keeping "ñ". */
export function fold(text: unknown): string {
  return String(text ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/ñ/g, '\u0001')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0001/g, 'ñ');
}

/** Comparison key: folded, punctuation removed, single spaces. */
export function normalizeKey(text: unknown): string {
  return fold(text).replace(/[^a-zñ0-9]+/g, ' ').trim();
}

function uniqueLabels(values: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const label = String(value ?? '').trim();
    const key = normalizeKey(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

const LOWERCASE_WORDS = new Set(['de', 'del', 'y', 'e', 'al', 'en']);
const ARTICLES = new Set(['la', 'las', 'los', 'el']);
const STREET_TYPE_LABELS = new Map([
  ['av', 'Av.'],
  ['avda', 'Av.'],
  ['avenida', 'Av.'],
  ['pje', 'Pje.'],
  ['pasaje', 'Pje.'],
  ['bv', 'Bv.'],
  ['calle', 'Calle'],
]);

/** "AV DE LOS CORRALES" → "Av. de los Corrales"; USIG's "CERVIÑO AV." → "Av. Cerviño". */
export function toTitleCase(text: unknown): string {
  let value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  const trailingType = value.match(/^(.+?)[\s,]+(?:AV|AVDA|AVENIDA)\.?(?:\s+(.+))?$/i);
  if (trailingType) value = ['AV', trailingType[2], trailingType[1]].filter(Boolean).join(' ');
  let nameStart = 0;
  return value
    .toLowerCase()
    .split(' ')
    .map((word, i) => {
      const typeLabel = i === 0 ? STREET_TYPE_LABELS.get(word.replace(/\.$/, '')) : undefined;
      if (typeLabel) {
        nameStart = 1;
        return typeLabel;
      }
      if (i > 0 && LOWERCASE_WORDS.has(word)) return word;
      if (i > nameStart && ARTICLES.has(word)) return word;
      if (i > 0 && /^[ivxl]{1,6}$/.test(word)) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

const MONTHS = new Set([
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'setiembre', 'octubre', 'noviembre', 'diciembre',
]);

const STREET_TYPES = new Set([
  'av', 'avda', 'avd', 'avenida', 'calle', 'pasaje', 'pje', 'psje', 'bv', 'bvard',
  'bulevar', 'boulevard', 'boulevar', 'diagonal', 'diag', 'camino', 'ruta',
  'autopista', 'au', 'costanera', 'cortada', 'peatonal', 'rn', 'rp',
]);

/** Street types whose name can be a plain number: "calle 7", "ruta 8". */
const NUMBERED_TYPES = new Set(['calle', 'ruta', 'diagonal', 'diag', 'pasaje', 'pje', 'rn', 'rp', 'camino']);

/** Words that cannot end a street name. */
const OPEN_ENDED = new Set([
  'y', 'e', 'entre', 'esq', 'esquina', 'al', 'de', 'del', 'la', 'las', 'los', 'el',
  'san', 'santa', 'santo', 'sta', 'sto', 'n', 'nro', 'numero', 'altura',
]);

/** Words that are not enough, on their own, to name a street. */
const TITLES = new Set([
  'gral', 'general', 'grl', 'dr', 'doctor', 'dra', 'doctora', 'pte', 'presidente', 'pres',
  'tte', 'teniente', 'cnel', 'coronel', 'ing', 'ingeniero', 'sgto', 'sargento', 'cap',
  'capitan', 'alte', 'almirante', 'cmte', 'comandante', 'cdte', 'mcal', 'mariscal',
  'brig', 'brigadier', 'gob', 'gobernador', 'int', 'intendente', 'prof', 'profesor',
  'mtro', 'maestro', 'fray', 'padre', 'pbro', 'hno', 'villa', 'barrio', 'km',
]);

/** Filler around a place name: "partido de", "localidad", "pdo." */
const PLACE_FILLER = new Set(['pdo', 'partido', 'loc', 'localidad', 'barrio', 'bo', 'municipio', 'mun', 'de', 'del', 'en']);

/** Words that may precede the door number: "al 5000", "nro 12". */
const NUMBER_PREFIXES = new Set(['al', 'altura', 'n', 'nro', 'numero', 'num', 'no']);

const ABBREVIATIONS: Readonly<Record<string, string>> = {
  av: 'avenida', avda: 'avenida', gral: 'general', grl: 'general', pte: 'presidente',
  pres: 'presidente', tte: 'teniente', cnel: 'coronel', dr: 'doctor', dra: 'doctora',
  ing: 'ingeniero', sgto: 'sargento', alte: 'almirante', cap: 'capitan', cmte: 'comandante',
  cdte: 'comandante', sta: 'santa', sto: 'santo', fco: 'francisco', bme: 'bartolome',
  pje: 'pasaje', psje: 'pasaje', bv: 'boulevard', mcal: 'mariscal', brig: 'brigadier',
  gob: 'gobernador', prof: 'profesor', mtro: 'maestro', pbro: 'presbitero', hno: 'hermano',
};

const expand = (token: string): string => ABBREVIATIONS[token] ?? token;

/* -------------------------------------------------------------------------- */
/* Places of the AMBA                                                          */
/* -------------------------------------------------------------------------- */

const CABA_ALIASES = [
  'caba', 'c a b a', 'capital', 'capital federal', 'cap fed', 'cap federal',
  'ciudad de buenos aires', 'ciudad autonoma de buenos aires', 'ciudad autonoma de bs as',
  'cdad autonoma de buenos aires', 'cdad autonoma de bs as', 'cdad de buenos aires',
  'cdad de bs as', 'ciudad de bs as', 'ciudad autonoma', 'cdad autonoma',
  'bs as capital', 'buenos aires capital', 'capital bs as', 'ciudad buenos aires',
];

const CABA_NEIGHBORHOODS = [
  'agronomia', 'almagro', 'balvanera', 'barracas', 'belgrano', 'boedo', 'caballito',
  'chacarita', 'coghlan', 'colegiales', 'constitucion', 'flores', 'floresta', 'la boca',
  'boca', 'la paternal', 'paternal', 'liniers', 'mataderos', 'monte castro', 'monserrat',
  'montserrat', 'nueva pompeya', 'pompeya', 'nuñez', 'nunez', 'palermo',
  'parque avellaneda', 'parque chacabuco', 'parque chas', 'parque patricios',
  'puerto madero', 'recoleta', 'retiro', 'saavedra', 'san cristobal', 'san nicolas',
  'san telmo', 'velez sarsfield', 'velez sarfield', 'versalles', 'villa crespo',
  'villa del parque', 'villa devoto', 'devoto', 'villa general mitre', 'villa gral mitre',
  'villa lugano', 'lugano', 'villa luro', 'villa ortuzar', 'villa pueyrredon', 'villa real',
  'villa riachuelo', 'villa santa rita', 'villa soldati', 'soldati', 'villa urquiza',
  'urquiza', 'microcentro', 'once', 'abasto', 'barrio norte', 'congreso', 'tribunales',
  'palermo soho', 'palermo hollywood', 'palermo chico', 'palermo viejo', 'las cañitas',
  'belgrano r', 'belgrano c', 'parque centenario', 'villa 31', 'barrio 31', 'barrio mugica',
  'bajo flores', 'ciudad oculta', 'villa 21 24', 'villa 1 11 14', 'rodrigo bueno',
  'barrio ramon carrillo', 'villa 20', 'los piletones', 'barrio piedrabuena',
];

/** Districts ("partidos"): official name first, then common spellings. */
const DISTRICTS: readonly (readonly [string, ...string[]])[] = [
  ['Almirante Brown', 'alte brown', 'alm brown'],
  ['Avellaneda'],
  ['Berazategui'],
  ['Berisso'],
  ['Brandsen', 'coronel brandsen', 'cnel brandsen'],
  ['Campana'],
  ['Cañuelas'],
  ['Ensenada'],
  ['Escobar'],
  ['Esteban Echeverría', 'e echeverria', 'echeverria'],
  ['Exaltación de la Cruz'],
  ['Ezeiza'],
  ['Florencio Varela', 'f varela', 'fcio varela', 'varela'],
  ['General Las Heras', 'gral las heras'],
  ['General Rodríguez', 'gral rodriguez'],
  ['General San Martín', 'gral san martin', 'san martin'],
  ['Hurlingham'],
  ['Ituzaingó'],
  ['José C. Paz', 'jose clemente paz', 'j c paz'],
  ['La Matanza', 'matanza'],
  ['La Plata'],
  ['Lanús'],
  ['Lomas de Zamora', 'lomas'],
  ['Luján'],
  ['Malvinas Argentinas'],
  ['Marcos Paz'],
  ['Merlo'],
  ['Moreno'],
  ['Morón'],
  ['Pilar'],
  ['Presidente Perón', 'pte peron'],
  ['Quilmes'],
  ['San Fernando'],
  ['San Isidro'],
  ['San Miguel'],
  ['San Vicente'],
  ['Tigre'],
  ['Tres de Febrero', '3 de febrero'],
  ['Vicente López', 'vte lopez', 'v lopez'],
  ['Zárate'],
];

const LOCALITIES: Readonly<Record<string, readonly string[]>> = {
  'Vicente López': ['Olivos', 'Florida', 'Florida Oeste', 'Munro', 'Carapachay', 'Villa Martelli', 'La Lucila'],
  'San Isidro': ['Martínez', 'Acassuso', 'Béccar', 'Boulogne', 'Boulogne Sur Mer'],
  'San Fernando': ['Victoria', 'Virreyes'],
  Tigre: ['Don Torcuato', 'General Pacheco', 'Pacheco', 'El Talar', 'Benavídez', 'Nordelta', 'Rincón de Milberg', 'Troncos del Talar', 'Ricardo Rojas'],
  'General San Martín': ['Villa Ballester', 'José León Suárez', 'Billinghurst', 'San Andrés', 'Villa Maipú', 'Chilavert', 'Villa Lynch'],
  'Tres de Febrero': ['Caseros', 'Ciudadela', 'Santos Lugares', 'Villa Bosch', 'Martín Coronado', 'Loma Hermosa', 'Sáenz Peña', 'Villa Raffo', 'Pablo Podestá', 'Churruca', 'Once de Septiembre', 'Ciudad Jardín Lomas del Palomar', 'José Ingenieros'],
  Morón: ['Castelar', 'Haedo', 'Villa Sarmiento'],
  Hurlingham: ['William Morris', 'Villa Tesei'],
  Ituzaingó: ['Villa Udaondo'],
  'La Matanza': ['San Justo', 'Ramos Mejía', 'Lomas del Mirador', 'La Tablada', 'Tapiales', 'Villa Madero', 'Aldo Bonzi', 'Isidro Casanova', 'Gregorio de Laferrere', 'Laferrere', 'González Catán', 'Rafael Castillo', 'Villa Luzuriaga', 'Ciudad Evita', 'Virrey del Pino', '20 de Junio', 'Villa Celina'],
  'Lomas de Zamora': ['Banfield', 'Temperley', 'Turdera', 'Llavallol', 'Ingeniero Budge', 'Villa Fiorito', 'Fiorito', 'Villa Centenario'],
  Lanús: ['Lanús Este', 'Lanús Oeste', 'Remedios de Escalada', 'Valentín Alsina', 'Monte Chingolo', 'Villa Caraza'],
  Avellaneda: ['Sarandí', 'Wilde', 'Dock Sud', 'Villa Domínico', 'Piñeyro', 'Crucecita'],
  Quilmes: ['Bernal', 'Don Bosco', 'Ezpeleta', 'Quilmes Oeste'],
  Berazategui: ['Hudson', 'Ranelagh', 'Sourigues', 'Plátanos', 'Juan María Gutiérrez'],
  'Florencio Varela': ['Bosques', 'Zeballos', 'Villa Vatteone', 'Ingeniero Allan'],
  'Almirante Brown': ['Adrogué', 'Burzaco', 'Longchamps', 'Glew', 'Rafael Calzada', 'José Mármol', 'Claypole', 'Ministro Rivadavia'],
  'Esteban Echeverría': ['Monte Grande', 'Luis Guillón', 'El Jagüel', '9 de Abril'],
  Ezeiza: ['Tristán Suárez', 'Carlos Spegazzini', 'La Unión'],
  Merlo: ['San Antonio de Padua', 'Padua', 'Parque San Martín', 'Libertad', 'Pontevedra', 'Mariano Acosta'],
  Moreno: ['Paso del Rey', 'La Reja', 'Francisco Álvarez', 'Trujui', 'Cuartel V'],
  'Malvinas Argentinas': ['Los Polvorines', 'Grand Bourg', 'Pablo Nogués', 'Villa de Mayo', 'Tierras Altas', 'Ingeniero Adolfo Sourdeaux'],
  'San Miguel': ['Bella Vista', 'Muñiz', 'Santa María'],
  Pilar: ['Del Viso', 'Presidente Derqui', 'Derqui', 'Villa Rosa', 'Manzanares', 'Manuel Alberti'],
  Escobar: ['Belén de Escobar', 'Garín', 'Ingeniero Maschwitz', 'Maquinista Savio', 'Matheu'],
  'La Plata': ['City Bell', 'Gonnet', 'Manuel B. Gonnet', 'Tolosa', 'Villa Elvira', 'Los Hornos', 'Ringuelet', 'Villa Elisa', 'Gorina', 'Melchor Romero'],
  'Presidente Perón': ['Guernica'],
};

/** Localities split between two districts. */
const SHARED_LOCALITIES: Readonly<Record<string, readonly string[]>> = {
  'Villa Adelina': ['San Isidro', 'Vicente López'],
  'El Palomar': ['Morón', 'Tres de Febrero'],
  Gerli: ['Lanús', 'Avellaneda'],
  Canning: ['Esteban Echeverría', 'Ezeiza'],
  'San Francisco Solano': ['Quilmes', 'Almirante Brown'],
  Solano: ['Quilmes', 'Almirante Brown'],
  Tortuguitas: ['Malvinas Argentinas', 'José C. Paz'],
};

const PROVINCE_ALIASES = [
  'provincia de buenos aires', 'pcia de buenos aires', 'prov de buenos aires',
  'provincia buenos aires', 'pcia buenos aires', 'prov buenos aires', 'provincia de bs as',
  'pcia de bs as', 'prov de bs as', 'pcia bs as', 'prov bs as', 'bs as provincia',
  'buenos aires provincia', 'pba', 'gba', 'gran buenos aires', 'conurbano',
  'conurbano bonaerense', 'provincia', 'pcia', 'prov',
];

/** "Buenos Aires" alone may mean the city or the province. */
const AMBIGUOUS_ALIASES = ['buenos aires', 'bs as', 'bsas', 'bs aires'];

const CABA: Readonly<Place> = Object.freeze({ kind: 'caba', province: '02', districts: [], label: 'CABA', usigName: 'CABA' });
const PBA: Readonly<Place> = Object.freeze({ kind: 'province', province: '06', districts: [], label: 'Provincia de Buenos Aires', usigName: '' });
const AMBIGUOUS: Readonly<Place> = Object.freeze({ kind: 'ambiguous', province: null, districts: [], label: 'Buenos Aires', usigName: '' });

const PLACES = new Map<string, Readonly<Place>>();

function addPlace(alias: string, place: Readonly<Place>): void {
  const key = normalizeKey(alias);
  if (key && !PLACES.has(key)) PLACES.set(key, place);
}

CABA_ALIASES.forEach((alias) => addPlace(alias, CABA));
CABA_NEIGHBORHOODS.forEach((alias) => addPlace(alias, CABA));
for (const [official, ...aliases] of DISTRICTS) {
  const place: Place = { kind: 'district', province: '06', districts: [official], label: official, usigName: official };
  [official, ...aliases].forEach((alias) => addPlace(alias, Object.freeze(place)));
}
for (const [district, names] of Object.entries(LOCALITIES)) {
  for (const name of names) {
    addPlace(name, Object.freeze({ kind: 'locality', province: '06', districts: [district], label: name, usigName: name }));
  }
}
for (const [name, districts] of Object.entries(SHARED_LOCALITIES)) {
  addPlace(name, Object.freeze({ kind: 'locality', province: '06', districts: [...districts], label: name, usigName: name }));
}
PROVINCE_ALIASES.forEach((alias) => addPlace(alias, PBA));
AMBIGUOUS_ALIASES.forEach((alias) => addPlace(alias, AMBIGUOUS));

const LEADING_ALIASES = new Set(CABA_ALIASES.map(normalizeKey));
const FUZZY_ALIASES = [...PLACES.keys()].filter((key) => key.length >= 5);

/** Optimal string alignment distance, giving up once it exceeds `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous2: number[] | null = null;
  let previous: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const row: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + cost);
      if (previous2 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, previous2[j - 2] + 1);
      }
      row.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > max) return max + 1;
    previous2 = previous;
    previous = row;
  }
  return previous[b.length];
}

/** Finds a CABA neighborhood, district, locality or province, tolerating typos. */
export function findPlace(text: string): Readonly<Place> | null {
  const key = normalizeKey(text);
  if (!key) return null;
  const exact = PLACES.get(key);
  if (exact) return exact;
  if (key.length < 5 || /^[\d ]+$/.test(key)) return null;
  const max = key.length >= 10 ? 2 : 1;
  let best: Readonly<Place> | null = null;
  let bestDistance = max + 1;
  for (const alias of FUZZY_ALIASES) {
    const distance = editDistance(key, alias, max);
    if (distance < bestDistance) {
      best = PLACES.get(alias) ?? null;
      bestDistance = distance;
    }
  }
  return bestDistance <= max ? best : null;
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

function preclean(input: string): { text: string; postalHint: string | null } {
  let postalHint: string | null = null;
  const notePostalCode = (_match: string, letter?: string): string => {
    if (!postalHint && letter) postalHint = letter;
    return ' ';
  };
  const text = fold(input)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[;|]+/g, ',')
    .replace(/(\d{1,2})\.(\d{3})\b/g, '$1$2') // "11.500" → "11500"
    .replace(/\be\s*\/\s*/g, ' entre ')
    .replace(/\bs\s*\/\s*n(?:ro)?\b/g, ' ')
    .replace(/\bsin\s+(?:numero|nro|altura)\b/g, ' ')
    .replace(/(\d)\s*\/\s*\d+/g, '$1') // "1371/79" → "1371"
    .replace(/[/\\]+/g, ' ')
    // Postal codes: "C1425", "C1425DDA", "B1638", "CP 1425", "(1425)".
    .replace(/\b(?:c\.?\s?p\.?|cod(?:igo)?\.?\s+postal)\s*:?\s*([a-hj-np-z])?\d{4}[a-z]{0,3}\b/g, notePostalCode)
    .replace(/\b([a-hj-np-z])\d{4}(?:[a-z]{3})?\b/g, notePostalCode)
    .replace(/\(\s*\d{4}\s*\)/g, ' ')
    // Country name as its own trailing part.
    .replace(/(^|,)\s*(?:rep(?:ublica)?\.?\s+)?argentina\s*(?=,|$)/g, '$1')
    .replace(/\s+(?:rep(?:ublica)?\.?\s+)?argentina\s*$/g, '')
    // Door-number markers: "N° 1234", "nro. 1234", "#1234".
    .replace(/\b(?:nro|num|numero)\s*[.:°º]?\s*(?=\d)/g, ' ')
    .replace(/\bn\s*[°º.]\s*(?=\d)/g, ' ')
    .replace(/#\s*(?=\d)/g, ' ')
    // Floor and unit.
    .replace(/\bpiso\s*[a-z0-9°º]*/g, ' ')
    .replace(/\b(?:p\.?\s?b\.?|planta\s+baja)(?=[\s,]|$)/g, ' ')
    .replace(/\b(?:dpto|depto|dto|dept|dep|departamento)\.?\s*[a-z0-9]{0,4}\b/g, ' ')
    .replace(
      /\b(?:unidad\s+funcional|u\.?\s?f|of|oficina|local|lote|casa|torre|monoblock|block|tira|timbre|manzana|mza|mz|edificio|edif)\.?\s*(?:\d+[a-z]?|[a-z])\b/g,
      ' ',
    )
    // An ordinal right after the door number is the floor: "3417 3° B", "3417, 1er".
    .replace(/(\d)(\s*,?\s*)\d{1,2}\s*(?:°|º|ero|er|ro|do|to|vo|no|mo)(?!\s*de\s)(?:\s*[a-z]\b)?/g, '$1$2')
    // Corners.
    .replace(/\b(?:esq|esquina)\b\.?/g, ' y ')
    .replace(/&/g, ' y ')
    // Punctuation.
    .replace(/[^a-zñ0-9°º,\s]/g, ' ')
    .replace(/\s*,\s*/g, ',')
    .replace(/,+/g, ',')
    .replace(/\s+/g, ' ')
    .replace(/^,|,$/g, '')
    .trim();
  return { text, postalHint };
}

function isStreetEnough(tokens: string[]): boolean {
  if (!tokens.length || OPEN_ENDED.has(tokens[tokens.length - 1])) return false;
  return tokens.some(
    (token, i) =>
      (/[a-zñ]{2,}/.test(token) && !STREET_TYPES.has(token) && !TITLES.has(token) && !OPEN_ENDED.has(token)) ||
      (NUMBERED_TYPES.has(token) && /^\d/.test(tokens[i + 1] ?? '')),
  );
}

interface Stripped {
  tokens: string[];
  places: Readonly<Place>[];
}

/**
 * Removes place names from the end of a token list ("... 500 vicente lopez").
 * With `requireStreet`, what remains must still name a street, so "Florida"
 * or "corrientes y florida" keep their street.
 */
function stripTrailingPlaces(tokens: string[], requireStreet: boolean): Stripped {
  let end = tokens.length;
  const places: Readonly<Place>[] = [];
  while (end > 0) {
    let found: { place: Readonly<Place>; start: number } | null = null;
    for (let size = Math.min(6, end); size >= 1 && !found; size -= 1) {
      const start = end - size;
      if (requireStreet && !isStreetEnough(tokens.slice(0, start))) continue;
      const place = findPlace(tokens.slice(start, end).join(' '));
      if (place) found = { place, start };
    }
    if (found) {
      places.unshift(found.place);
      end = found.start;
      continue;
    }
    const canDropFiller = requireStreet ? places.length > 0 && isStreetEnough(tokens.slice(0, end - 1)) : true;
    if (PLACE_FILLER.has(tokens[end - 1]) && canDropFiller) {
      end -= 1;
      continue;
    }
    break;
  }
  return { tokens: tokens.slice(0, end), places };
}

function coverWithPlaces(tokens: string[]): Readonly<Place>[] | null {
  const { tokens: rest, places } = stripTrailingPlaces(tokens, false);
  return rest.length === 0 && places.length ? places : null;
}

/** "caba roseti 253": only city aliases are trusted at the start. */
function leadingPlace(tokens: string[]): { place: Readonly<Place>; size: number } | null {
  for (let size = Math.min(5, tokens.length - 1); size >= 1; size -= 1) {
    const rest = tokens.slice(size);
    if (LEADING_ALIASES.has(tokens.slice(0, size).join(' ')) && isStreetEnough(rest) && rest.some((t) => /^\d/.test(t))) {
      return { place: CABA, size };
    }
  }
  return null;
}

/** Numbers that belong to the street name: "25 de mayo", "calle 7", "11 de septiembre de 1888". */
function isNamePart(tokens: string[], i: number): boolean {
  const previous = tokens[i - 1];
  const next = tokens[i + 1];
  if (next === 'de' && MONTHS.has(tokens[i + 2])) return true;
  if (next === 'orientales') return true;
  if (previous === 'de' && MONTHS.has(tokens[i - 2])) return true;
  if (NUMBERED_TYPES.has(previous) && tokens[i].length <= 3) return true;
  return false;
}

function splitNumber(tokens: string[]): { name: string[]; number: string | null; bis: boolean } {
  const positions: number[] = [];
  tokens.forEach((token, i) => {
    if (/^\d{1,5}[a-z]?$/.test(token) && !isNamePart(tokens, i)) positions.push(i);
  });
  if (!positions.length) return { name: tokens, number: null, bis: false };
  let at = positions[positions.length - 1];
  if (positions.length > 1) {
    const before = positions[positions.length - 2];
    // "3417 3 b": a one- or two-digit number right after the door number is the floor.
    if (tokens[at].replace(/\D/g, '').length <= 2 && at - before === 1) at = before;
  }
  let name = tokens.slice(0, at);
  while (name.length && NUMBER_PREFIXES.has(name[name.length - 1])) name = name.slice(0, -1);
  return { name, number: tokens[at].replace(/\D/g, ''), bis: tokens[at + 1] === 'bis' };
}

const isConnector = (token: string): boolean => token === 'y' || token === 'e' || token === 'entre';

function firstStreet(tokens: string[]): string[] {
  const cut = tokens.findIndex(isConnector);
  return cut > 0 ? tokens.slice(0, cut) : tokens;
}

function withoutStreetType(tokens: string[]): string[] {
  let i = 0;
  while (
    i < tokens.length - 1 &&
    STREET_TYPES.has(tokens[i]) &&
    !(NUMBERED_TYPES.has(tokens[i]) && /^\d/.test(tokens[i + 1]))
  ) {
    i += 1;
  }
  return tokens.slice(i);
}

/** Alternative spellings to retry with when the first query finds nothing. */
function variantsOf(query: string): string[] {
  const tokens = query.split(' ');
  const expanded = tokens.map(expand).join(' ');
  const ordinalSwapped = tokens
    .map((token, i) => {
      if (tokens[i + 1] === 'de') return token;
      if (/^1(?:°|º|ro|ero)$/.test(token)) return 'primo';
      if (token === 'primo') return '1';
      return token;
    })
    .join(' ');
  const untyped = withoutStreetType(tokens).join(' ');
  return [...new Set([expanded, ordinalSwapped, untyped])].filter((variant) => variant && variant !== query);
}

function pickPlace(places: readonly Readonly<Place>[], postalHint: string | null): Place | null {
  const locality = places.find((p) => p.kind === 'locality');
  const district = places.find((p) => p.kind === 'district');
  if (locality && district) {
    const match = locality.districts.find((d) => sameDistrict(d, district.districts[0]));
    return match
      ? { ...locality, districts: [match], label: `${locality.label}, ${district.label}` }
      : { ...district };
  }
  if (locality || district) return { ...(locality ?? district)! };
  if (places.some((p) => p.kind === 'caba')) return { ...CABA };
  if (places.some((p) => p.kind === 'province')) return { ...PBA };
  if (postalHint === 'c') return { ...CABA, fromPostalCode: true };
  if (postalHint === 'b') return { ...PBA, fromPostalCode: true };
  return null;
}

function emptyParse(input: string): ParsedAddress {
  return {
    input,
    valid: false,
    reason: null,
    query: '',
    variants: [],
    street: '',
    streetBase: '',
    number: null,
    intersection: false,
    missingNumber: false,
    place: null,
    places: [],
    postalHint: null,
    unrecognized: '',
  };
}

/** Splits a hand-typed address into street, door number and place. */
export function parseAddress(input: string): ParsedAddress {
  const result = emptyParse(String(input ?? '').replace(/\s+/g, ' ').trim());
  if (result.input.length < 3) return { ...result, reason: 'too_short' };

  const { text: cleaned, postalHint } = preclean(result.input);
  result.postalHint = postalHint;

  const segments = cleaned
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const tokens = part.split(' ');
      return { tokens, places: coverWithPlaces(tokens) };
    });
  const hasLetters = (tokens: string[]) => tokens.some((t) => /[a-zñ]/.test(t));
  const hasNumber = (tokens: string[]) => tokens.some((t) => /^\d/.test(t));
  let streetIndex = segments.findIndex((s) => !s.places && hasLetters(s.tokens) && hasNumber(s.tokens));
  if (streetIndex < 0) streetIndex = segments.findIndex((s) => !s.places && hasLetters(s.tokens));

  const places: Readonly<Place>[] = [];
  const unrecognized: string[] = [];
  segments.forEach((segment, i) => {
    if (i === streetIndex) return;
    if (segment.places) {
      places.push(...segment.places);
      return;
    }
    const stripped = stripTrailingPlaces(segment.tokens, false);
    places.push(...stripped.places);
    const leftover = stripped.tokens.join(' ');
    if (/[a-zñ]{3,}/.test(leftover) && !/\d/.test(leftover)) unrecognized.push(leftover);
  });

  const invalid = (): ParsedAddress => ({
    ...result,
    reason: 'no_street',
    places: places.map((p) => ({ ...p })),
    place: pickPlace(places, postalHint),
  });
  if (streetIndex < 0) return invalid();

  const trailing = stripTrailingPlaces(segments[streetIndex].tokens, true);
  let tokens = trailing.tokens;
  const leading = leadingPlace(tokens);
  if (leading) {
    tokens = tokens.slice(leading.size);
    places.push(leading.place);
  }
  places.push(...trailing.places);

  const { name, number, bis } = splitNumber(tokens);
  const nameTokens = number ? name : tokens;
  const streetTokens = firstStreet(nameTokens);
  if (!isStreetEnough(nameTokens) || !isStreetEnough(streetTokens)) return invalid();

  const query = number ? [...name, number, ...(bis ? ['bis'] : [])].join(' ') : tokens.join(' ');
  const intersection = !number && tokens.some(isConnector);
  return {
    ...result,
    valid: true,
    query,
    variants: variantsOf(query),
    street: streetTokens.join(' '),
    streetBase: withoutStreetType(streetTokens).join(' '),
    number,
    intersection,
    missingNumber: !number && !intersection,
    place: pickPlace(places, postalHint),
    places: places.map((p) => ({ ...p })),
    unrecognized: unrecognized.join(', '),
  };
}

/* -------------------------------------------------------------------------- */
/* Geometry                                                                    */
/* -------------------------------------------------------------------------- */

export function distanceKm(a: Point, b: Point): number {
  const R = 6371.0088;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A coordinate pair inside mainland Argentina (a sanity box, not a border check). */
export function toPoint(lat: unknown, lon: unknown): Point | null {
  if ([lat, lon].some((v) => v === null || v === undefined || v === '')) return null;
  const point = { lat: Number(lat), lon: Number(lon) };
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return null;
  if (point.lat < -56 || point.lat > -21 || point.lon < -74 || point.lon > -53) return null;
  return point;
}

/* -------------------------------------------------------------------------- */
/* Network                                                                     */
/* -------------------------------------------------------------------------- */

interface RequestOptions {
  signal?: AbortSignal;
}

const abortError = (): DOMException => new DOMException('Lookup cancelled', 'AbortError');

async function getJSON<T>(url: string, { signal }: RequestOptions = {}): Promise<T> {
  if (signal?.aborted) throw abortError();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const timer = setTimeout(cancel, REQUEST_TIMEOUT_MS);
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
      credentials: 'omit',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as T;
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (controller.signal.aborted) throw new Error('Request timed out');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

let jsonpCounter = 0;

/** USIG serves cross-origin pages through JSONP (its official client uses `callback`). */
function getJSONP<T>(url: string, { signal }: RequestOptions = {}): Promise<T> {
  if (typeof document === 'undefined') return Promise.reject(new Error('JSONP needs a browser'));
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    jsonpCounter += 1;
    const name = `__usig_${Date.now().toString(36)}_${jsonpCounter}`;
    const registry = window as unknown as Record<string, unknown>;
    const script = document.createElement('script');
    let done = false;
    const finish = (error: unknown, data?: T): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      script.remove();
      registry[name] = () => {}; // a late answer must not throw
      setTimeout(() => delete registry[name], 60_000);
      if (error) reject(error);
      else resolve(data as T);
    };
    const onAbort = () => finish(abortError());
    const timer = setTimeout(() => finish(new Error('USIG timed out')), REQUEST_TIMEOUT_MS);
    registry[name] = (data: T) => finish(null, data);
    script.onerror = () => finish(new Error('USIG request failed'));
    script.onload = () => {
      setTimeout(() => finish(new Error('USIG sent no JSONP payload')), 0);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    script.src = `${url}${url.includes('?') ? '&' : '?'}callback=${name}`;
    document.head.append(script);
  });
}

/* -------------------------------------------------------------------------- */
/* Providers                                                                   */
/* -------------------------------------------------------------------------- */

interface Named {
  id?: string | null;
  nombre?: string | null;
}

interface GeorefAddress {
  altura?: { valor?: string | number | null } | null;
  calle?: Named | null;
  calle_cruce_1?: Named | null;
  departamento?: Named | null;
  localidad?: Named | null;
  localidad_censal?: Named | null;
  provincia?: Named | null;
  ubicacion?: { lat?: unknown; lon?: unknown } | null;
}

interface GeorefHeights {
  inicio?: { derecha?: unknown; izquierda?: unknown } | null;
  fin?: { derecha?: unknown; izquierda?: unknown } | null;
}

interface GeorefStreet {
  nombre?: string | null;
  provincia?: Named | null;
  departamento?: Named | null;
  localidad_censal?: Named | null;
  altura?: GeorefHeights | null;
}

interface UsigAddress {
  altura?: string | number | null;
  coordenadas?: { srid?: unknown; x?: unknown; y?: unknown } | null;
  nombre_calle?: string | null;
  nombre_calle_cruce?: string | null;
  nombre_localidad?: string | null;
  nombre_partido?: string | null;
  cod_partido?: string | null;
  tipo?: string | null;
}

interface UsigResponse {
  errorMessage?: string;
  direccionesNormalizadas?: UsigAddress[];
}

interface NominatimPlace {
  lat?: unknown;
  lon?: unknown;
  name?: string;
  display_name?: string;
  address?: Partial<
    Record<'road' | 'pedestrian' | 'footway' | 'house_number' | 'state' | 'city' | 'suburb' | 'city_district' | 'town' | 'village' | 'county', string>
  >;
}

interface CandidateInput {
  point: Point | null;
  street: string;
  crossing?: string;
  number: string | number | null | undefined;
  province: string | null;
  district: string;
  area: string;
  source: Source;
  kind?: CandidateKind;
}

function makeCandidate({ point, street, crossing, number, province, district, area, source, kind }: CandidateInput): Candidate {
  const hasNumber = number !== null && number !== undefined && number !== '' && Number(number) !== 0;
  const via = crossing ? `${street} y ${crossing}` : hasNumber ? `${street} ${number}` : street;
  return {
    lat: point?.lat ?? null,
    lon: point?.lon ?? null,
    street,
    number: hasNumber ? String(number) : null,
    province,
    district,
    area,
    via,
    label: area ? `${via}, ${area}` : via,
    source,
    kind: kind ?? (crossing ? 'intersection' : hasNumber ? 'address' : 'street'),
  };
}

const isLocated = (candidate: Candidate): candidate is LocatedCandidate =>
  candidate.lat !== null && candidate.lon !== null;

interface Zone {
  province: ProvinceId;
  district: string;
  label: string;
}

async function georefAddresses(query: string, zone: Zone, options: RequestOptions): Promise<Candidate[]> {
  const params = new URLSearchParams({ direccion: query, max: '10', provincia: zone.province });
  if (zone.district) params.set('departamento', zone.district);
  const data = await getJSON<{ direcciones?: GeorefAddress[] }>(`${PROVIDERS.georef}/direcciones?${params}`, options);
  if (!Array.isArray(data?.direcciones)) throw new Error('Georef: unexpected response');
  return data.direcciones.map(fromGeoref).filter((c): c is Candidate => c !== null);
}

function fromGeoref(item: GeorefAddress): Candidate | null {
  const street = toTitleCase(item?.calle?.nombre);
  if (!street) return null;
  const province = item.provincia?.id ?? null;
  const district = item.departamento?.nombre ?? '';
  const locality = item.localidad?.nombre || item.localidad_censal?.nombre || '';
  return makeCandidate({
    point: toPoint(item.ubicacion?.lat, item.ubicacion?.lon),
    street,
    crossing: toTitleCase(item.calle_cruce_1?.nombre),
    number: item.altura?.valor,
    province,
    district,
    area: province === '02' ? 'CABA' : uniqueLabels([locality, district]).join(', ') || item.provincia?.nombre || '',
    source: 'Georef',
  });
}

async function georefStreets(name: string, zone: Zone, options: RequestOptions): Promise<StreetInfo[]> {
  const params = new URLSearchParams({ nombre: name, max: '5', provincia: zone.province });
  if (zone.district) params.set('departamento', zone.district);
  const data = await getJSON<{ calles?: GeorefStreet[] }>(`${PROVIDERS.georef}/calles?${params}`, options);
  if (!Array.isArray(data?.calles)) throw new Error('Georef: unexpected response');
  const streets: StreetInfo[] = [];
  for (const item of data.calles) {
    const street = toTitleCase(item?.nombre);
    if (!street) continue;
    const province = item.provincia?.id ?? null;
    streets.push({
      street,
      province,
      district: item.departamento?.nombre ?? '',
      area:
        province === '02'
          ? 'CABA'
          : item.departamento?.nombre || item.localidad_censal?.nombre || item.provincia?.nombre || '',
      range: numberRange(item.altura),
    });
  }
  return streets;
}

function numberRange(heights: GeorefHeights | null | undefined): NumberRange | null {
  if (!heights) return null;
  const values = [heights.inicio?.derecha, heights.inicio?.izquierda, heights.fin?.derecha, heights.fin?.izquierda]
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  return values.length >= 2 ? { from: Math.min(...values), to: Math.max(...values) } : null;
}

let usigNeedsJsonp = false;

async function usigAddresses(
  query: string,
  usigName: string,
  options: RequestOptions,
): Promise<{ results: Candidate[]; message: string }> {
  const params = new URLSearchParams({
    direccion: usigName ? `${query}, ${usigName}` : query,
    geocodificar: 'TRUE',
    srid: '4326',
    maxOptions: '10',
  });
  const url = `${PROVIDERS.usig}?${params}`;
  let data: UsigResponse;
  if (usigNeedsJsonp) {
    data = await getJSONP<UsigResponse>(url, options);
  } else {
    try {
      data = await getJSON<UsigResponse>(url, options);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error; // only CORS/network failures fall back to JSONP
      data = await getJSONP<UsigResponse>(url, options);
      usigNeedsJsonp = true; // skip the failing fetch from now on
    }
  }
  if (data?.errorMessage) return { results: [], message: String(data.errorMessage) };
  if (!Array.isArray(data?.direccionesNormalizadas)) throw new Error('USIG: unexpected response');
  return {
    results: data.direccionesNormalizadas.map(fromUsig).filter((c): c is Candidate => c !== null),
    message: '',
  };
}

function fromUsig(item: UsigAddress): Candidate | null {
  const street = toTitleCase(item?.nombre_calle);
  if (!street) return null;
  const isCaba = normalizeKey(item.cod_partido) === 'caba' || normalizeKey(item.nombre_partido) === 'caba';
  const point = Number(item.coordenadas?.srid) === 4326 ? toPoint(item.coordenadas?.y, item.coordenadas?.x) : null;
  return makeCandidate({
    point,
    street,
    crossing: toTitleCase(item.nombre_calle_cruce),
    number: item.tipo === 'calle_y_calle' ? null : item.altura,
    province: isCaba ? '02' : '06',
    district: isCaba ? '' : String(item.nombre_partido ?? ''),
    area: isCaba ? 'CABA' : uniqueLabels([item.nombre_localidad, item.nombre_partido]).join(', '),
    source: 'USIG',
  });
}

let lastNominatimAt = 0;

async function nominatimSearch(text: string, options: RequestOptions): Promise<Candidate[]> {
  const wait = lastNominatimAt + NOMINATIM_GAP_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastNominatimAt = Date.now();
  const params = new URLSearchParams({
    q: text,
    format: 'jsonv2',
    addressdetails: '1',
    limit: '5',
    countrycodes: 'ar',
    'accept-language': 'es',
    viewbox: '-59.30,-34.20,-57.80,-35.20',
    bounded: '0',
  });
  const data = await getJSON<NominatimPlace[]>(`${PROVIDERS.nominatim}?${params}`, options);
  if (!Array.isArray(data)) throw new Error('Nominatim: unexpected response');
  return data.map(fromNominatim).filter((c): c is Candidate => c !== null);
}

function fromNominatim(item: NominatimPlace): Candidate | null {
  const point = toPoint(item?.lat, item?.lon);
  if (!point) return null;
  const address = item.address ?? {};
  const isCaba = [address.state, address.city].some((v) => /autonoma de buenos aires/.test(fold(v)));
  const street = address.road || address.pedestrian || address.footway || '';
  const number = street ? address.house_number || null : null;
  return makeCandidate({
    point,
    street: street || item.name || String(item.display_name ?? '').split(',')[0],
    number,
    province: isCaba ? '02' : null,
    district: address.county ?? '',
    area: isCaba
      ? 'CABA'
      : uniqueLabels([
          address.suburb || address.city_district || address.town || address.city || address.village,
          address.county,
        ]).join(', '),
    source: 'OpenStreetMap',
    kind: street ? (number ? 'address' : 'street') : 'area',
  });
}

/* -------------------------------------------------------------------------- */
/* Search strategy                                                             */
/* -------------------------------------------------------------------------- */

const AMBA_ZONES: readonly Zone[] = Object.freeze([
  Object.freeze({ province: '02', district: '', label: 'CABA' }),
  Object.freeze({ province: '06', district: '', label: 'Provincia de Buenos Aires' }),
]);

function zonesFor(place: Place | null): readonly Zone[] {
  if (!place || place.kind === 'ambiguous') return AMBA_ZONES;
  if (place.kind === 'caba') return [AMBA_ZONES[0]];
  if (place.kind === 'province') return [AMBA_ZONES[1]];
  return place.districts.map((district) => ({ province: '06', district, label: place.label }));
}

function districtKey(name: unknown): string {
  return normalizeKey(name)
    .replace(/\b3\b/g, 'tres')
    .replace(/\b(?:partido|de|del|la|general|gral)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sameDistrict(a: unknown, b: unknown): boolean {
  const x = districtKey(a);
  const y = districtKey(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

function matchesZone(candidate: Candidate, zone: Zone): boolean {
  if (zone.province === '02') return candidate.province === '02';
  if (candidate.province && candidate.province !== zone.province) return false;
  if (!zone.district) return true;
  return sameDistrict(candidate.district, zone.district) || sameDistrict(candidate.area, zone.district);
}

async function georefInZone(parsed: ParsedAddress, zone: Zone, options: RequestOptions): Promise<Candidate[]> {
  for (const query of [parsed.query, ...parsed.variants]) {
    const found = await georefAddresses(query, zone, options);
    if (found.length) return found;
  }
  return [];
}

interface ZoneQuery {
  found: LocatedCandidate[];
  elsewhere: LocatedCandidate[];
  unlocated: Candidate[];
  failures: number;
  requests: number;
  usigMessage: string;
}

async function queryZones(
  parsed: ParsedAddress,
  zones: readonly Zone[],
  usigName: string,
  options: RequestOptions,
): Promise<ZoneQuery> {
  let usigMessage = '';
  const requests: Promise<Candidate[]>[] = zones.map((zone) => georefInZone(parsed, zone, options));
  requests.push(
    usigAddresses(parsed.query, usigName, options).then(({ results, message }) => {
      usigMessage = message;
      return results;
    }),
  );
  const settled = await Promise.allSettled(requests);
  if (options.signal?.aborted) throw abortError();
  const all = settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
  const inZone = (candidate: Candidate) => zones.some((zone) => matchesZone(candidate, zone));
  return {
    found: all.filter(isLocated).filter(inZone),
    elsewhere: all.filter(isLocated).filter((c) => !inZone(c)),
    unlocated: all.filter((c) => !isLocated(c) && inZone(c)),
    failures: settled.filter((s) => s.status === 'rejected').length,
    requests: settled.length,
    usigMessage,
  };
}

function sourceRank(candidate: Candidate): number {
  const order: Source[] = candidate.province === '02' ? ['USIG', 'Georef', 'OpenStreetMap'] : ['Georef', 'USIG', 'OpenStreetMap'];
  const rank = order.indexOf(candidate.source);
  return rank < 0 ? order.length : rank;
}

/** Merges answers that point to the same spot and sorts the rest by distance to `center`. */
function mergeCandidates(candidates: LocatedCandidate[], center: Point): Match[] {
  const groups: Match[] = [];
  for (const candidate of [...candidates].sort((a, b) => sourceRank(a) - sourceRank(b))) {
    const same = groups.find((group) => distanceKm(group, candidate) < SAME_POINT_KM);
    if (same) {
      if (!same.sources.includes(candidate.source)) same.sources.push(candidate.source);
      continue;
    }
    groups.push({ ...candidate, sources: [candidate.source], centerDistance: distanceKm(candidate, center) });
  }
  return groups.sort((a, b) => a.centerDistance - b.centerDistance);
}

type Decision = { status: 'ok'; match: Match; choices: Match[] } | { status: 'choices'; match: null; choices: Match[] };

function decide(groups: Match[], { forceChoices = false } = {}): Decision {
  const nearby = groups.filter((g) => g.centerDistance <= AMBA_RADIUS_KM);
  const list = nearby.length ? nearby : groups;
  const first = list[0];
  const oneArea = list.every((g) => distanceKm(g, first) < SAME_AREA_KM);
  const precise = first.kind === 'address' || first.kind === 'intersection';
  if (!forceChoices && oneArea && precise) return { status: 'ok', match: first, choices: [] };
  return { status: 'choices', match: null, choices: list.slice(0, 6) };
}

function nominatimText(parsed: ParsedAddress): string {
  const street = parsed.query.split(' ').map(expand).join(' ');
  const { place } = parsed;
  let area = parsed.unrecognized;
  if (place?.kind === 'caba') area = 'Ciudad Autónoma de Buenos Aires';
  else if (place?.kind === 'province') area = 'Provincia de Buenos Aires';
  else if (place) area = `${place.label}, Provincia de Buenos Aires`;
  return [street, area, 'Argentina'].filter(Boolean).join(', ');
}

async function findSuggestions(
  parsed: ParsedAddress,
  zones: readonly Zone[],
  unlocated: Candidate[],
  options: RequestOptions,
): Promise<{ suggestions: Suggestion[]; knownStreet: KnownStreet | null }> {
  const known = unlocated.find((c) => c.kind !== 'street');
  let knownStreet: KnownStreet | null = known
    ? { street: known.street, area: known.area, range: null, notOnMap: true }
    : null;
  const name = parsed.streetBase || parsed.street;
  if (normalizeKey(name).replace(/\s/g, '').length < 3) return { suggestions: [], knownStreet };

  const settled = await Promise.allSettled(zones.map((zone) => georefStreets(name, zone, options)));
  if (options.signal?.aborted) throw abortError();
  const seen = new Set<string>();
  const streets: StreetInfo[] = [];
  for (const street of settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []))) {
    const key = normalizeKey(`${street.street} ${street.area}`);
    if (seen.has(key)) continue;
    seen.add(key);
    streets.push(street);
  }

  const base = normalizeKey(name);
  const own = streets.find((s) => withoutStreetType(normalizeKey(s.street).split(' ')).join(' ') === base);
  if (own && parsed.number && !knownStreet) {
    knownStreet = { street: own.street, area: own.area, range: own.range, notOnMap: false };
  }
  const suggestions = streets
    .filter((s) => !(parsed.number && s === own))
    .slice(0, 5)
    .map((s) => ({ ...s, text: `${[s.street, parsed.number].filter(Boolean).join(' ')}, ${s.area}` }));
  return { suggestions, knownStreet };
}

/**
 * Resolves a hand-typed address.
 *
 * - `ok`: one clear location.
 * - `choices`: several places match; let the person pick.
 * - `not_found`: nothing matched; may include a known street and suggestions.
 * - `invalid`: the text has no street.
 * - `error`: every provider failed.
 */
export async function geocodeAddress(input: string, options: GeocodeOptions = {}): Promise<GeocodeResult> {
  const { signal, center = CABA_CENTER, suggest = true } = options;
  const parsed = parseAddress(input);
  const notices: string[] = [];
  if (!parsed.valid) return { status: 'invalid', reason: parsed.reason, notices, parsed };
  const request: RequestOptions = { signal };
  if (parsed.unrecognized && !parsed.place) {
    notices.push(`«${parsed.unrecognized}» no figura como barrio, localidad o partido del AMBA: se buscó en toda la zona.`);
  }

  const zones = zonesFor(parsed.place);
  const first = await queryZones(parsed, zones, parsed.place?.usigName ?? '', request);
  let failures = first.failures;
  let requests = first.requests;
  if (first.found.length) {
    return { ...decide(mergeCandidates(first.found, center)), notices, parsed };
  }

  // Nothing in the place the person wrote: look in the rest of the AMBA.
  if (parsed.place) {
    let elsewhere = first.elsewhere;
    const remaining = AMBA_ZONES.filter((zone) => !zones.some((z) => z.province === zone.province && !z.district));
    if (remaining.length) {
      const second = await queryZones(parsed, remaining, '', request);
      failures += second.failures;
      requests += second.requests;
      elsewhere = [...elsewhere, ...second.found, ...second.elsewhere];
    }
    if (elsewhere.length) {
      notices.push(`No aparece en ${parsed.place.label}. Estas son las coincidencias en otras zonas.`);
      return { ...decide(mergeCandidates(elsewhere, center), { forceChoices: true }), notices, parsed };
    }
  }

  // Last resort: OpenStreetMap.
  let osm: LocatedCandidate[] = [];
  requests += 1;
  try {
    osm = (await nominatimSearch(nominatimText(parsed), request)).filter(isLocated);
  } catch {
    if (signal?.aborted) throw abortError();
    failures += 1;
  }
  if (osm.length) {
    const inZone = parsed.place ? osm.filter((c) => zones.some((zone) => matchesZone(c, zone))) : osm;
    notices.push('Ubicación aproximada según OpenStreetMap: confirmá que sea la correcta.');
    return { ...decide(mergeCandidates(inZone.length ? inZone : osm, center)), notices, parsed };
  }

  if (failures === requests) return { status: 'error', notices, parsed };
  if (failures) notices.push('Algún servicio de direcciones no respondió: el resultado puede estar incompleto.');
  const { suggestions, knownStreet } = suggest
    ? await findSuggestions(parsed, zones, first.unlocated, request)
    : { suggestions: [], knownStreet: null };
  return { status: 'not_found', suggestions, knownStreet, usigMessage: first.usigMessage, notices, parsed };
}
