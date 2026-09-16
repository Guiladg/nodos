import { describe, expect, it } from 'vitest';
import { findPlace, parseAddress, toTitleCase, type Place } from '../src/geocoder.ts';

type ExpectedPlace = Partial<Place> | null;

const CABA: ExpectedPlace = { kind: 'caba' };
const district = (name: string): ExpectedPlace => ({ kind: 'district', districts: [name] });
const locality = (label: string, districtName: string): ExpectedPlace => ({
  kind: 'locality',
  districts: [districtName],
  label,
});

// [input, expected query, expected place (partial) or null]
const cases: [string, string, ExpectedPlace][] = [
  ['Roseti 253, caba', 'roseti 253', CABA],
  ['Roseti 253 caba', 'roseti 253', CABA],
  ['caba roseti 253', 'roseti 253', CABA],
  ['Roseti N° 253 (1427) Capital Federal', 'roseti 253', CABA],
  ['libertador 500, Vicente López', 'libertador 500', district('Vicente López')],
  ['libertador 500 vicente lopez', 'libertador 500', district('Vicente López')],
  ['libertador 500 vte lopes', 'libertador 500', district('Vicente López')],
  ['libertador 500, pdo. de vicente lopez, pcia. de bs. as.', 'libertador 500', district('Vicente López')],
  ['libertador 500', 'libertador 500', null],
  ['Av. Cerviño 3417, C1425 Cdad. Autónoma de Buenos Aires', 'av cerviño 3417', CABA],
  ['cerviño 3417 3° B palermo', 'cerviño 3417', CABA],
  ['Cerviño 3417 piso 3 dto B, CABA', 'cerviño 3417', CABA],
  ['Cerviño 3417 1°B', 'cerviño 3417', null],
  ['cerviño 3417 3 b', 'cerviño 3417', null],
  ['25 de mayo 1234 san martin', '25 de mayo 1234', district('General San Martín')],
  ['2 de Abril de 1982 6850, Lugano', '2 de abril de 1982 6850', CABA],
  ['3 de febrero 2500 belgrano', '3 de febrero 2500', CABA],
  ['Humberto 1° 470, San Telmo', 'humberto 1° 470', CABA],
  ['Florida 500', 'florida 500', null],
  ['san martin 1200 florida', 'san martin 1200', locality('Florida', 'Vicente López')],
  ['maipu 2356 olivos vicente lopez', 'maipu 2356', { kind: 'locality', districts: ['Vicente López'], label: 'Olivos, Vicente López' }],
  ['Av. La Plata 2241', 'av la plata 2241', null],
  ['Rivadavia al 5000, Caballito', 'rivadavia 5000', CABA],
  ['Rivadavia 11.500, Liniers', 'rivadavia 11500', CABA],
  ['calle 7 n° 1234, La Plata', 'calle 7 1234', district('La Plata')],
  ['calle 12 1345 berazategui', 'calle 12 1345', district('Berazategui')],
  ['hipolito yrigoyen 3164 lanus', 'hipolito yrigoyen 3164', district('Lanús')],
  ['moreno 1234', 'moreno 1234', null],
  ['Pilar 950', 'pilar 950', null],
  ['Av. de los Corrales 6999 esq. Carhué, Mataderos', 'av de los corrales 6999', CABA],
  ['Juramento 2000 entre Cabildo y Arcos, Belgrano', 'juramento 2000', CABA],
  ['Gral. Paz 5000, lomas del mirador', 'gral paz 5000', locality('Lomas del Mirador', 'La Matanza')],
  ['avenida de mayo 786 ramos mejia', 'avenida de mayo 786', locality('Ramos Mejía', 'La Matanza')],
  ['Laprida 1500 banfield', 'laprida 1500', locality('Banfield', 'Lomas de Zamora')],
  ['Mitre 500, Avellaneda', 'mitre 500', district('Avellaneda')],
  ['Av. Avellaneda 3000, Flores', 'av avellaneda 3000', CABA],
  ['sarmiento 1394 san miguel', 'sarmiento 1394', district('San Miguel')],
  ['Libertad 1234, Recoleta', 'libertad 1234', CABA],
  ['Paraná 6000, Villa Adelina', 'parana 6000', { kind: 'locality', districts: ['San Isidro', 'Vicente López'] }],
  ['Fragata Presidente Sarmiento 2152, CABA', 'fragata presidente sarmiento 2152', CABA],
  ['Soldado de la Frontera 5144, CABA', 'soldado de la frontera 5144', CABA],
  ['Galván 3463, CABA', 'galvan 3463', CABA],
  ['Iriarte 3501, CABA', 'iriarte 3501', CABA],
  ['Balbastro 3998, San Justo, Buenos Aires, Argentina', 'balbastro 3998', locality('San Justo', 'La Matanza')],
  ['Libertador 500, B1638 Vicente López, Provincia de Buenos Aires', 'libertador 500', district('Vicente López')],
  ['Corrientes 1234 dpto 5, Buenos Aires', 'corrientes 1234', null],
];

describe('parseAddress', () => {
  it.each(cases)('parses "%s"', (input, query, place) => {
    const parsed = parseAddress(input);
    expect(parsed.valid).toBe(true);
    expect(parsed.query).toBe(query);
    if (place === null) expect(parsed.place).toBeNull();
    else expect(parsed.place).toMatchObject(place);
  });

  it('keeps both streets of an intersection', () => {
    const plain = parseAddress('corrientes y callao');
    expect(plain).toMatchObject({ query: 'corrientes y callao', intersection: true, place: null });

    const corner = parseAddress('corrientes esq. callao caba');
    expect(corner.query).toBe('corrientes y callao');
    expect(corner.place?.kind).toBe('caba');

    const florida = parseAddress('corrientes y florida');
    expect(florida).toMatchObject({ query: 'corrientes y florida', place: null });
  });

  it('flags a street without number', () => {
    expect(parseAddress('av la plata')).toMatchObject({ valid: true, missingNumber: true, place: null });
    // A bare place name with no number reads as the place, so the UI asks for street and number.
    expect(parseAddress('san martin').reason).toBe('no_street');
  });

  it('rejects text without a street', () => {
    expect(parseAddress('1234').valid).toBe(false);
    expect(parseAddress('caba')).toMatchObject({ valid: false, reason: 'no_street', place: { kind: 'caba' } });
    expect(parseAddress('ab').reason).toBe('too_short');
  });

  it('uses the postal code letter as a province hint', () => {
    expect(parseAddress('Roseti 253, C1427').place).toMatchObject({ kind: 'caba', fromPostalCode: true });
  });

  it('reports unknown places instead of guessing', () => {
    expect(parseAddress('san martin 500, villa galicia')).toMatchObject({ place: null, unrecognized: 'villa galicia' });
  });

  it('builds spelling variants', () => {
    expect(parseAddress('Gral. Paz 5000').variants).toContain('general paz 5000');
    expect(parseAddress('Humberto 1° 470').variants).toContain('humberto primo 470');
    expect(parseAddress('Humberto Primo 470').variants).toContain('humberto 1 470');
    expect(parseAddress('Av. La Plata 2241').variants).toContain('la plata 2241');
  });
});

describe('findPlace', () => {
  it('tolerates typos without false positives', () => {
    expect(findPlace('Lomas de Zamorra')?.districts).toEqual(['Lomas de Zamora']);
    expect(findPlace('palemro')?.kind).toBe('caba');
    expect(findPlace('torre')).toBeNull();
    expect(findPlace('fondo')).toBeNull();
  });
});

describe('toTitleCase', () => {
  it.each([
    ['AV DE LOS CORRALES', 'Av. de los Corrales'],
    ['AV LA PLATA', 'Av. La Plata'],
    ['CERVIÑO AV.', 'Av. Cerviño'],
    ['LIBERTADOR AV. DEL', 'Av. del Libertador'],
    ['HUMBERTO 1º', 'Humberto 1º'],
    ['PIO XII', 'Pio XII'],
    ['SOLDADO DE LA FRONTERA', 'Soldado de la Frontera'],
  ])('formats "%s"', (input, expected) => {
    expect(toTitleCase(input)).toBe(expected);
  });
});
