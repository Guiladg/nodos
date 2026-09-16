import { beforeEach, describe, expect, it, vi } from 'vitest';
import { geocodeAddress } from '../src/geocoder.ts';

/* Fake providers ------------------------------------------------------------- */

type Handler = (params: URLSearchParams) => unknown;

let routes: Record<string, Handler> = {};
let calls: URL[] = [];

beforeEach(() => {
  routes = {};
  calls = [];
});

vi.stubGlobal('fetch', async (input: string | URL) => {
  const url = new URL(String(input));
  calls.push(url);
  const key = url.pathname.includes('/georef/')
    ? `georef${url.pathname.slice(url.pathname.lastIndexOf('/'))}`
    : url.hostname.includes('usig')
      ? 'usig'
      : 'nominatim';
  const handler = routes[key];
  if (!handler) throw new TypeError('Failed to fetch');
  const body = handler(url.searchParams);
  if (body instanceof Error) throw body;
  return { ok: true, status: 200, json: async () => body };
});

interface GeorefFixture {
  street: string;
  number: number;
  province?: '02' | '06';
  district?: string;
  locality?: string;
  lat: number;
  lon: number;
}

const georefItem = ({ street, number, province = '02', district = 'Comuna 1', locality = '', lat, lon }: GeorefFixture) => ({
  altura: { valor: number },
  calle: { nombre: street },
  calle_cruce_1: { nombre: null },
  departamento: { nombre: district },
  localidad_censal: { nombre: locality },
  provincia: { id: province, nombre: province === '02' ? 'Ciudad Autónoma de Buenos Aires' : 'Buenos Aires' },
  ubicacion: { lat, lon },
});

const usigItem = ({ street, number, x, y }: { street: string; number: number; x: number; y: number }) => ({
  altura: number,
  coordenadas: { srid: 4326, x: String(x), y: String(y) },
  nombre_calle: street,
  nombre_calle_cruce: '',
  nombre_localidad: 'CABA',
  nombre_partido: 'CABA',
  cod_partido: 'caba',
  tipo: 'calle_altura',
});

/* Tests ---------------------------------------------------------------------- */

describe('geocodeAddress', () => {
  it('resolves a CABA address found by both providers to one match', async () => {
    const seen: string[] = [];
    routes['georef/direcciones'] = (q) => {
      seen.push(`${q.get('provincia')}|${q.get('direccion')}`);
      return { direcciones: [georefItem({ street: 'AV CERVIÑO', number: 3417, district: 'Comuna 14', lat: -34.58079, lon: -58.41155 })] };
    };
    routes.usig = (q) => {
      seen.push(`usig|${q.get('direccion')}`);
      return { direccionesNormalizadas: [usigItem({ street: 'CERVIÑO AV.', number: 3417, x: -58.41149, y: -34.58085 })] };
    };
    const result = await geocodeAddress('Av. Cerviño 3417, C1425 Cdad. Autónoma de Buenos Aires');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.match.label).toBe('Av. Cerviño 3417, CABA');
    expect(result.match.sources).toEqual(['USIG', 'Georef']);
    expect(seen).toEqual(['02|av cerviño 3417', 'usig|av cerviño 3417, CABA']);
  });

  it('offers choices, nearest first, when a street exists in several places', async () => {
    routes['georef/direcciones'] = (q) =>
      q.get('provincia') === '02'
        ? { direcciones: [georefItem({ street: 'AV DEL LIBERTADOR', number: 500, lat: -34.5905, lon: -58.3775 })] }
        : {
            direcciones: [
              georefItem({ street: 'AV DEL LIBERTADOR', number: 500, province: '06', district: 'San Isidro', locality: 'San Isidro', lat: -34.472, lon: -58.51 }),
              georefItem({ street: 'AV DEL LIBERTADOR', number: 500, province: '06', district: 'Vicente López', locality: 'Vicente López', lat: -34.527, lon: -58.47 }),
            ],
          };
    routes.usig = () => ({ errorMessage: 'Debe especificar el partido' });
    const result = await geocodeAddress('libertador 500');
    expect(result.status).toBe('choices');
    if (result.status !== 'choices') return;
    expect(result.choices.map((c) => c.label)).toEqual([
      'Av. del Libertador 500, CABA',
      'Av. del Libertador 500, Vicente López',
      'Av. del Libertador 500, San Isidro',
    ]);
  });

  it('offers other zones, with a notice, when the written place has nothing', async () => {
    routes['georef/direcciones'] = (q) =>
      !q.get('departamento') && q.get('provincia') === '02'
        ? { direcciones: [georefItem({ street: 'ROSETI', number: 253, district: 'Comuna 15', lat: -34.5866, lon: -58.4558 })] }
        : { direcciones: [] };
    routes.usig = () => ({ direccionesNormalizadas: [] });
    const result = await geocodeAddress('roseti 253, vicente lopez');
    expect(result.status).toBe('choices');
    if (result.status !== 'choices') return;
    expect(result.choices[0].label).toBe('Roseti 253, CABA');
    expect(result.notices[0]).toMatch(/No aparece en Vicente López/);
  });

  it('retries spelling variants when the first query finds nothing', async () => {
    const queries: string[] = [];
    routes['georef/direcciones'] = (q) => {
      queries.push(q.get('direccion') ?? '');
      return q.get('direccion') === 'humberto primo 470'
        ? { direcciones: [georefItem({ street: 'HUMBERTO PRIMO', number: 470, lat: -34.6205, lon: -58.3712 })] }
        : { direcciones: [] };
    };
    routes.usig = () => ({ errorMessage: 'Calle inexistente' });
    const result = await geocodeAddress('Humberto 1° 470, CABA');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.match.label).toBe('Humberto Primo 470, CABA');
    expect(queries.slice(0, 2)).toEqual(['humberto 1° 470', 'humberto primo 470']);
  });

  it('still resolves when one provider is down', async () => {
    routes['georef/direcciones'] = () => new Error('HTTP 503');
    routes.usig = () => ({ direccionesNormalizadas: [usigItem({ street: 'ROSETI', number: 253, x: -58.4558, y: -34.5866 })] });
    const result = await geocodeAddress('roseti 253 caba');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.match.sources).toEqual(['USIG']);
  });

  it('uses OpenStreetMap as a last resort and flags it', async () => {
    routes['georef/direcciones'] = () => ({ direcciones: [] });
    routes.usig = () => ({ direccionesNormalizadas: [] });
    routes.nominatim = (q) => {
      expect(q.get('q')).toBe('calle falsa 123, Ciudad Autónoma de Buenos Aires, Argentina');
      return [{ lat: '-34.61', lon: '-58.42', address: { road: 'Calle Falsa', house_number: '123', state: 'Ciudad Autónoma de Buenos Aires' } }];
    };
    const result = await geocodeAddress('calle falsa 123, caba');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.match.source).toBe('OpenStreetMap');
    expect(result.notices.at(-1)).toMatch(/OpenStreetMap/);
  });

  it('reports a known street and suggests similar ones when nothing matches', async () => {
    routes['georef/direcciones'] = () => ({ direcciones: [] });
    routes.usig = () => ({ errorMessage: 'Altura inválida' });
    routes.nominatim = () => [];
    routes['georef/calles'] = () => ({
      calles: [
        {
          nombre: 'ROSETI',
          provincia: { id: '02' },
          departamento: { nombre: 'Comuna 15' },
          altura: { inicio: { derecha: 1, izquierda: 2 }, fin: { derecha: 1899, izquierda: 1900 } },
        },
        { nombre: 'ROSETTI', provincia: { id: '06' }, departamento: { nombre: 'Moreno' } },
      ],
    });
    const result = await geocodeAddress('roseti 9999, caba');
    expect(result.status).toBe('not_found');
    if (result.status !== 'not_found') return;
    expect(result.knownStreet).toMatchObject({ street: 'Roseti', range: { from: 1, to: 1900 } });
    expect(result.suggestions.map((s) => s.text)).toEqual(['Rosetti 9999, Moreno']);
  });

  it('reports an error when every provider fails', async () => {
    const result = await geocodeAddress('roseti 253, caba');
    expect(result.status).toBe('error');
  });

  it('searches the whole AMBA, with a notice, for unknown places', async () => {
    routes['georef/direcciones'] = (q) =>
      q.get('provincia') === '02'
        ? { direcciones: [georefItem({ street: 'ROSETI', number: 253, lat: -34.5866, lon: -58.4558 })] }
        : { direcciones: [] };
    routes.usig = () => ({ direccionesNormalizadas: [] });
    const result = await geocodeAddress('roseti 253, barrio los aromos');
    expect(result.status).toBe('ok');
    expect(result.notices[0]).toMatch(/los aromos/);
  });

  it('never calls the providers for text without a street', async () => {
    const result = await geocodeAddress('1234');
    expect(result.status).toBe('invalid');
    expect(calls).toHaveLength(0);
  });

  it('throws AbortError when the search is cancelled', async () => {
    routes['georef/direcciones'] = () => ({ direcciones: [] });
    routes.usig = () => ({ direccionesNormalizadas: [] });
    const controller = new AbortController();
    controller.abort();
    await expect(geocodeAddress('roseti 253', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
