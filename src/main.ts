import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './styles.css';
import { CABA_CENTER, distanceKm, geocodeAddress, normalizeKey, toPoint, type GeocodeResult, type Match, type Point } from './geocoder.ts';

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

/** One entry of public/nodos.json. Unknown keys are kept when exporting from #admin. */
interface NodeRecord {
	name: string;
	neighborhood?: string;
	hospital?: string;
	doctor?: string;
	address?: string;
	phone?: string;
	notes?: string;
	lat?: number;
	lon?: number;
	[key: string]: unknown;
}

type GeoState = 'fixed' | 'pending' | 'found' | 'failed';

interface CareNode {
	raw: NodeRecord;
	id: string;
	name: string;
	neighborhood: string;
	hospital: string;
	doctor: string;
	address: string;
	phone: string;
	notes: string;
	lat: number | null;
	lon: number | null;
	geo: GeoState;
	geoDetail: string;
	doubtful: boolean;
	distance: number | null;
	rank: number | null | undefined;
	marker: L.Marker | null;
}

type LocatedNode = CareNode & Point;

interface Patient extends Point {
	label: string;
	/** Providers that found the address, or "manual" when placed by hand. */
	sources: string[];
}

interface CachedLocation extends Point {
	detail: string;
	doubtful: boolean;
	savedAt: number;
}

type PatientInput = Point & { label: string; sources: readonly string[]; kind?: Match['kind'] };

/* -------------------------------------------------------------------------- */
/* Settings and state                                                          */
/* -------------------------------------------------------------------------- */

const NODES_URL = `${import.meta.env.BASE_URL}nodos.json`;
// Only node locations are cached. Patient addresses are never stored.
const CACHE_KEY = 'nodes-geocoded-v1';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const CHOICE_LETTERS = 'ABCDEF';

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const narrowScreen = window.matchMedia('(max-width: 959px)');
const kmFormat = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const state: {
	nodes: CareNode[];
	patient: Patient | null;
	patientMarker: L.Marker | null;
	choicesLayer: L.LayerGroup | null;
	picking: boolean;
	search: AbortController | null;
	mapTouched: boolean;
	admin: boolean;
} = {
	nodes: [],
	patient: null,
	patientMarker: null,
	choicesLayer: null,
	picking: false,
	search: null,
	mapTouched: false,
	admin: window.location.hash === '#admin'
};

/* -------------------------------------------------------------------------- */
/* DOM helpers                                                                 */
/* -------------------------------------------------------------------------- */

function $<T extends HTMLElement = HTMLElement>(selector: string): T {
	const element = document.querySelector<T>(selector);
	if (!element) throw new Error(`Missing element: ${selector}`);
	return element;
}

type Child = Node | string | number | null | undefined | false | Child[];
type PropValue = string | number | boolean | null | undefined | ((event: Event) => void);

/** Tiny DOM builder: el('p', { class: 'x', onclick }, 'text', child, [children]). */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, PropValue> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag);
	for (const [key, value] of Object.entries(props)) {
		if (value === null || value === undefined || value === false) continue;
		if (typeof value === 'function') element.addEventListener(key.replace(/^on/, ''), value);
		else if (key === 'class') element.className = String(value);
		else if (key === 'style') element.style.cssText = String(value);
		else element.setAttribute(key, value === true ? '' : String(value));
	}
	appendChildren(element, children);
	return element;
}

function appendChildren(parent: HTMLElement, children: Child[]): void {
	for (const child of children) {
		if (child === null || child === undefined || child === false || child === '') continue;
		if (Array.isArray(child)) appendChildren(parent, child);
		else parent.append(child instanceof Node ? child : String(child));
	}
}

const asText = (value: unknown): string => (value === null || value === undefined ? '' : String(value).trim());
const hasPoint = (node: CareNode): node is LocatedNode => node.lat !== null && node.lon !== null;
const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;
const isPrecise = (candidate: Pick<Match, 'kind'>): boolean => candidate.kind === 'address' || candidate.kind === 'intersection';
const displayAddress = (address: string): string => address.replace(/,\s*(?:caba|capital federal|ciudad aut[oó]noma de buenos aires)\s*$/i, '');

/* -------------------------------------------------------------------------- */
/* Map                                                                         */
/* -------------------------------------------------------------------------- */

const map = L.map('map', { zoomControl: true }).setView([CABA_CENTER.lat, CABA_CENTER.lon], 12);
L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION }).addTo(map);
map.on('dragstart', () => {
	state.mapTouched = true;
});
map.on('click', (event: L.LeafletMouseEvent) => {
	if (!state.picking) return;
	setPatient({ lat: event.latlng.lat, lon: event.latlng.lng, label: 'Punto marcado en el mapa', sources: ['manual'] }, { fit: false });
});

/* -------------------------------------------------------------------------- */
/* Nodes                                                                       */
/* -------------------------------------------------------------------------- */

async function loadNodes(): Promise<CareNode[]> {
	const response = await fetch(NODES_URL, { cache: 'no-cache' });
	if (!response.ok) throw new Error(`nodos.json: HTTP ${response.status}`);
	const data: unknown = await response.json();
	const list = Array.isArray(data) ? data : (data as { nodes?: unknown } | null)?.nodes;
	if (!Array.isArray(list)) throw new Error('nodos.json must contain a list of nodes');
	return list
		.filter((item): item is NodeRecord => typeof item === 'object' && item !== null && asText((item as NodeRecord).name) !== '')
		.map((item, index) => {
			const point = toPoint(item.lat, item.lon);
			return {
				raw: item,
				id: `node-${index + 1}`,
				name: asText(item.name),
				neighborhood: asText(item.neighborhood),
				hospital: asText(item.hospital),
				doctor: asText(item.doctor),
				address: asText(item.address),
				phone: asText(item.phone),
				notes: asText(item.notes),
				lat: point?.lat ?? null,
				lon: point?.lon ?? null,
				geo: point ? 'fixed' : 'pending',
				geoDetail: point ? 'Coordenadas fijas en nodos.json' : '',
				doubtful: false,
				distance: null,
				rank: undefined,
				marker: null
			};
		});
}

async function geocodeNodes(): Promise<void> {
	const cache = readCache();
	const pending: CareNode[] = [];
	for (const node of state.nodes) {
		if (node.geo === 'fixed') continue;
		if (!node.address) {
			node.geo = 'failed';
			continue;
		}
		const cached = cache[normalizeKey(node.address)];
		if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS && toPoint(cached.lat, cached.lon)) {
			Object.assign(node, { lat: cached.lat, lon: cached.lon, geo: 'found', geoDetail: cached.detail, doubtful: cached.doubtful });
		} else {
			pending.push(node);
		}
	}
	refresh();

	await runInPool(pending, 2, async (node) => {
		try {
			const result = await geocodeAddress(node.address, { suggest: false });
			const best = result.status === 'ok' ? result.match : result.status === 'choices' ? result.choices[0] : undefined;
			if (best) {
				Object.assign(node, {
					lat: best.lat,
					lon: best.lon,
					geo: 'found',
					geoDetail: `${best.label} (${best.sources.join(' + ')})`,
					doubtful: result.status !== 'ok'
				});
				cache[normalizeKey(node.address)] = {
					lat: best.lat,
					lon: best.lon,
					detail: node.geoDetail,
					doubtful: node.doubtful,
					savedAt: Date.now()
				};
				writeCache(cache);
			} else {
				node.geo = 'failed';
				console.warn(`Could not geocode "${node.name}" (${node.address}).`, result);
			}
		} catch (error) {
			node.geo = 'failed';
			console.warn(`Could not geocode "${node.name}".`, error);
		}
		refresh();
	});
}

async function runInPool<T>(items: T[], size: number, task: (item: T) => Promise<void>): Promise<void> {
	const queue = [...items];
	const workers = Array.from({ length: Math.min(size, queue.length) }, async () => {
		for (let item = queue.shift(); item !== undefined; item = queue.shift()) await task(item);
	});
	await Promise.all(workers);
}

function readCache(): Record<string, CachedLocation> {
	try {
		return JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}') as Record<string, CachedLocation>;
	} catch {
		return {};
	}
}

function writeCache(cache: Record<string, CachedLocation>): void {
	try {
		localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
	} catch {
		// Storage unavailable: nodes are geocoded again on the next visit.
	}
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

function refresh(): void {
	const patient = state.patient;
	for (const node of state.nodes) {
		node.distance = patient && hasPoint(node) ? distanceKm(patient, node) : null;
	}
	drawNodes();
	renderList();
	updateAdminPanel();
	if (!patient && !state.mapTouched) fitNodes();
}

function sortedNodes(): CareNode[] {
	if (!state.patient) return state.nodes;
	return [...state.nodes].sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
}

function drawNodes(): void {
	sortedNodes().forEach((node, index) => {
		if (!hasPoint(node)) return;
		const rank = node.distance !== null ? index + 1 : null;
		if (!node.marker) {
			const marker = L.marker([node.lat, node.lon], {
				icon: nodeIcon(rank),
				title: node.name,
				alt: node.name,
				riseOnHover: true,
				draggable: state.admin
			})
				.addTo(map)
				.bindPopup(() => nodePopup(node), { maxWidth: 260 });
			marker.on('click', () => highlightInList(node));
			if (state.admin) {
				marker.on('dragend', () => {
					const { lat, lng } = marker.getLatLng();
					Object.assign(node, { lat: round6(lat), lon: round6(lng), geo: 'fixed', geoDetail: 'Corregido a mano', doubtful: false });
					refresh();
				});
			}
			node.marker = marker;
		} else {
			node.marker.setLatLng([node.lat, node.lon]);
			if (node.rank !== rank) node.marker.setIcon(nodeIcon(rank));
		}
		node.rank = rank;
		node.marker.setZIndexOffset(rank ? 1000 - rank : 0);
	});
}

function nodeIcon(rank: number | null): L.DivIcon {
	const first = rank === 1;
	const size = first ? 38 : 30;
	return L.divIcon({
		className: `pin-node${first ? ' pin-node--first' : ''}${rank ? '' : ' pin-node--idle'}`,
		html: `<span>${rank ?? ''}</span>`,
		iconSize: [size, size],
		iconAnchor: [size / 2, size / 2],
		popupAnchor: [0, -size / 2]
	});
}

function nodePopup(node: CareNode): HTMLElement {
	return el(
		'div',
		{ class: 'popup' },
		el('strong', {}, node.name),
		node.neighborhood && el('span', {}, node.neighborhood),
		node.address && el('span', {}, displayAddress(node.address)),
		node.distance !== null && el('span', {}, `A ${formatDistance(node.distance)} del domicilio`),
		el('a', { href: directionsUrl(node), target: '_blank', rel: 'noopener' }, 'Cómo llegar')
	);
}

function formatDistance(km: number): string {
	if (km < 1) return `${Math.max(10, Math.round(km * 100) * 10)} m`;
	return `${kmFormat.format(km)} km`;
}

function directionsUrl(node: CareNode): string {
	const params = new URLSearchParams({
		api: '1',
		destination: node.address ? `${node.address}, Argentina` : `${node.lat},${node.lon}`,
		travelmode: 'transit'
	});
	if (state.patient) params.set('origin', `${state.patient.lat.toFixed(6)},${state.patient.lon.toFixed(6)}`);
	return `https://www.google.com/maps/dir/?${params}`;
}

function renderList(): void {
	const nodes = sortedNodes();
	const distances = nodes.map((node) => node.distance).filter((d): d is number => d !== null);
	const farthest = distances.length ? Math.max(...distances) : 0;
	$('#node-list').replaceChildren(...nodes.map((node, index) => nodeItem(node, index, farthest)));
	$('#list-title').textContent = state.patient ? 'Nodos por cercanía' : 'Nodos de la red';
	$('#list-note').textContent = state.patient
		? 'Distancia en línea recta desde el domicilio.'
		: `${state.nodes.length} nodos. Buscá un domicilio para ordenarlos por cercanía.`;
}

function nodeItem(node: CareNode, index: number, farthest: number): HTMLLIElement {
	const rank = state.patient && node.distance !== null ? index + 1 : null;
	const distance = node.distance ?? 0;
	const rulerWidth = farthest > 0 ? Math.max(6, Math.round((distance / farthest) * 100)) : 100;
	return el(
		'li',
		{ class: `node${rank === 1 ? ' node--first' : ''}`, id: node.id },
		el('span', { class: `node-badge${rank ? '' : ' node-badge--idle'}`, 'aria-hidden': 'true' }, rank),
		el(
			'div',
			{ class: 'node-body' },
			el('h3', { class: 'node-name' }, node.name, node.neighborhood && el('span', { class: 'node-area' }, `, ${node.neighborhood}`)),
			rank !== null &&
				el(
					'div',
					{ class: 'node-distance' },
					el('span', { class: 'ruler', 'aria-hidden': 'true' }, el('span', { style: `inline-size: ${rulerWidth}%` })),
					el('span', { class: 'node-km' }, formatDistance(distance))
				),
			node.hospital && el('p', { class: 'node-line' }, node.hospital),
			node.doctor && el('p', { class: 'node-line node-line--strong' }, node.doctor),
			node.address && el('p', { class: 'node-line' }, displayAddress(node.address)),
			node.phone && el('p', { class: 'node-line' }, el('a', { href: `tel:${node.phone.replace(/[^\d+]/g, '')}` }, node.phone)),
			node.notes && el('p', { class: 'node-line node-line--note' }, node.notes),
			geoNote(node),
			el(
				'div',
				{ class: 'node-actions' },
				el('a', { class: 'button button--primary', href: directionsUrl(node), target: '_blank', rel: 'noopener' }, 'Cómo llegar'),
				hasPoint(node) && el('button', { type: 'button', class: 'button button--secondary', onclick: () => showOnMap(node) }, 'Ver en el mapa')
			)
		)
	);
}

function geoNote(node: CareNode): HTMLParagraphElement | null {
	if (node.geo === 'pending') return el('p', { class: 'node-note' }, 'Ubicando en el mapa…');
	if (node.geo === 'failed') {
		return el('p', { class: 'node-note node-note--warning' }, 'No se pudo ubicar en el mapa. Revisá la dirección en nodos.json.');
	}
	if (state.admin) {
		return el('p', { class: `node-note${node.doubtful ? ' node-note--warning' : ''}` }, `${node.doubtful ? 'Revisar: ' : ''}${node.geoDetail}`);
	}
	return null;
}

function showOnMap(node: LocatedNode): void {
	if (narrowScreen.matches) $('#map').scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
	map.setView([node.lat, node.lon], Math.max(map.getZoom(), 15), { animate: !reducedMotion });
	node.marker?.openPopup();
}

function highlightInList(node: CareNode): void {
	const item = document.getElementById(node.id);
	if (!item) return;
	if (!narrowScreen.matches) item.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'nearest' });
	item.classList.remove('node--flash');
	void item.offsetWidth; // restart the animation
	item.classList.add('node--flash');
}

function fitNodes(): void {
	const points = state.nodes.filter(hasPoint).map((node): L.LatLngTuple => [node.lat, node.lon]);
	if (points.length) map.fitBounds(L.latLngBounds(points), { padding: [32, 32], maxZoom: 14, animate: false });
}

function fitPatient(patient: Patient): void {
	const nearest = sortedNodes().filter(hasPoint).slice(0, 3);
	const points: L.LatLngTuple[] = [[patient.lat, patient.lon], ...nearest.map((node): L.LatLngTuple => [node.lat, node.lon])];
	map.fitBounds(L.latLngBounds(points), { padding: [48, 48], maxZoom: 15, animate: !reducedMotion });
}

function nodesCenter(): Point {
	const located = state.nodes.filter(hasPoint);
	if (!located.length) return CABA_CENTER;
	return {
		lat: located.reduce((sum, node) => sum + node.lat, 0) / located.length,
		lon: located.reduce((sum, node) => sum + node.lon, 0) / located.length
	};
}

/* -------------------------------------------------------------------------- */
/* Search                                                                      */
/* -------------------------------------------------------------------------- */

function wireSearchForm(): void {
	const input = $<HTMLInputElement>('#address');
	const clear = $<HTMLButtonElement>('#clear-search');
	$<HTMLFormElement>('#search-form').addEventListener('submit', (event) => {
		event.preventDefault();
		void runSearch(input.value);
	});
	clear.addEventListener('click', () => {
		input.value = '';
		clearPatient();
		input.focus();
	});
	input.addEventListener('input', () => {
		clear.hidden = !input.value && !state.patient;
	});
}

async function runSearch(text: string): Promise<void> {
	const query = text.trim();
	state.search?.abort();
	stopPicking();
	if (query.length < 3) {
		showStatus(warningBox('Escribí calle y altura, por ejemplo «Balcarce 50, CABA».'));
		return;
	}
	const controller = new AbortController();
	state.search = controller;
	forgetPatient(); // the map and list must never show a previous patient's address
	$('#clear-search').hidden = false;
	showStatus(el('p', { class: 'status-loading' }, 'Buscando la dirección…'), { busy: true });

	let result: GeocodeResult | null;
	try {
		result = await geocodeAddress(query, { signal: controller.signal, center: nodesCenter() });
	} catch (error) {
		if (error instanceof DOMException && error.name === 'AbortError') return;
		console.error(error);
		result = null;
	} finally {
		if (state.search === controller) state.search = null;
	}
	if (controller.signal.aborted) return;

	switch (result?.status) {
		case 'ok':
			$('#address').blur();
			setPatient(result.match, { notices: result.notices });
			break;
		case 'choices':
			showChoices(result.choices, result.notices, query);
			break;
		case 'not_found':
			showNotFound(result, query);
			break;
		case 'invalid':
			showStatus(warningBox('Falta la calle o la altura. Escribí, por ejemplo, «Balcarce 50, CABA».'));
			break;
		default:
			showStatus(errorBox(query));
	}
}

function setPatient(candidate: PatientInput, { notices = [] as string[], fit = true } = {}): void {
	stopPicking();
	clearChoicesLayer();
	const patient: Patient = {
		lat: candidate.lat,
		lon: candidate.lon,
		label: candidate.label,
		sources: [...candidate.sources]
	};
	state.patient = patient;
	if (!state.patientMarker) {
		const marker = L.marker([patient.lat, patient.lon], {
			icon: L.divIcon({ className: 'pin-patient', html: '<span></span>', iconSize: [26, 34], iconAnchor: [13, 32] }),
			draggable: true,
			zIndexOffset: 2000,
			title: 'Domicilio del paciente',
			alt: 'Domicilio del paciente',
			keyboard: false
		}).addTo(map);
		marker.on('dragend', () => {
			const { lat, lng } = marker.getLatLng();
			const base = (state.patient?.label ?? 'Domicilio').replace(/ \(ajustado en el mapa\)$/, '');
			setPatient({ lat, lon: lng, label: `${base} (ajustado en el mapa)`, sources: ['manual'] }, { fit: false });
		});
		state.patientMarker = marker;
	} else {
		state.patientMarker.setLatLng([patient.lat, patient.lon]);
	}
	refresh();
	showStatus(locationBox(patient, notices));
	$('#clear-search').hidden = false;
	if (fit) fitPatient(patient);
}

function forgetPatient(): void {
	clearChoicesLayer();
	if (!state.patient) return;
	state.patient = null;
	state.patientMarker?.remove();
	state.patientMarker = null;
	refresh();
}

function clearPatient(): void {
	state.search?.abort();
	stopPicking();
	state.mapTouched = false;
	forgetPatient();
	refresh();
	showStatus(null);
	$('#clear-search').hidden = true;
}

function showStatus(content: HTMLElement | null, { busy = false } = {}): void {
	const box = $('#status');
	box.replaceChildren(...(content ? [content] : []));
	box.setAttribute('aria-busy', String(busy));
}

function locationBox(patient: Patient, notices: string[]): HTMLElement {
	const manual = patient.sources.includes('manual');
	return el(
		'div',
		{ class: 'result' },
		el('p', { class: 'result-address' }, el('span', { class: 'patient-dot', 'aria-hidden': 'true' }), patient.label),
		el(
			'p',
			{ class: 'result-note' },
			manual ? 'Ubicación marcada a mano.' : `Según ${patient.sources.join(' y ')}. Si el pin no quedó en el lugar exacto, arrastralo.`
		),
		notices.map((text) => el('p', { class: 'result-notice' }, text)),
		el('div', { class: 'result-actions' }, el('button', { type: 'button', class: 'button button--secondary', onclick: startPicking }, 'Corregir en el mapa'))
	);
}

function showChoices(choices: Match[], notices: string[], query: string): void {
	const choose = (choice: Match) => setPatient(choice, { notices: isPrecise(choice) ? [] : ['Ubicación aproximada: ajustá el pin si hace falta.'] });
	const title = choices.length > 1 ? `Hay ${choices.length} lugares que coinciden con «${query}». Elegí el correcto:` : '¿Es este el domicilio?';
	showStatus(
		el(
			'div',
			{ class: 'result' },
			notices.map((text) => el('p', { class: 'result-notice' }, text)),
			el('p', { class: 'result-title' }, title),
			el(
				'ul',
				{ class: 'choices' },
				choices.map((choice, i) =>
					el(
						'li',
						{},
						el(
							'button',
							{ type: 'button', class: 'choice', onclick: () => choose(choice) },
							el('span', { class: 'choice-letter', 'aria-hidden': 'true' }, CHOICE_LETTERS[i]),
							el('span', { class: 'choice-via' }, choice.via),
							el('span', { class: 'choice-area' }, [choice.area, isPrecise(choice) ? '' : '(aproximado)'].filter(Boolean).join(' '))
						)
					)
				)
			),
			el('button', { type: 'button', class: 'link-button', onclick: startPicking }, 'Ninguno: marcar en el mapa')
		)
	);
	showChoicesOnMap(choices, choose);
}

function showChoicesOnMap(choices: Match[], choose: (choice: Match) => void): void {
	clearChoicesLayer();
	const markers = choices.map((choice, i) =>
		L.marker([choice.lat, choice.lon], {
			icon: L.divIcon({ className: 'pin-choice', html: `<span>${CHOICE_LETTERS[i]}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] }),
			title: choice.label,
			alt: choice.label,
			zIndexOffset: 1500
		}).on('click', () => choose(choice))
	);
	state.choicesLayer = L.layerGroup(markers).addTo(map);
	const points = choices.map((choice): L.LatLngTuple => [choice.lat, choice.lon]);
	map.fitBounds(L.latLngBounds(points), { padding: [48, 48], maxZoom: 15, animate: !reducedMotion });
}

function clearChoicesLayer(): void {
	state.choicesLayer?.remove();
	state.choicesLayer = null;
}

function showNotFound(result: Extract<GeocodeResult, { status: 'not_found' }>, query: string): void {
	const { knownStreet, suggestions, parsed, notices } = result;
	const children: Child[] = [el('p', { class: 'result-title' }, `No se encontró «${query}».`)];
	if (knownStreet) {
		const range = knownStreet.range ? ` La numeración va del ${knownStreet.range.from} al ${knownStreet.range.to}.` : '';
		children.push(
			el(
				'p',
				{},
				knownStreet.notOnMap
					? `${knownStreet.street} ${parsed.number} existe en ${knownStreet.area}, pero no tiene ubicación en el mapa. Marcala a mano.`
					: `${knownStreet.street} existe en ${knownStreet.area}, pero no se encontró la altura ${parsed.number}.${range}`
			)
		);
	}
	if (suggestions.length) {
		children.push(
			el('p', {}, '¿Quisiste decir…?'),
			el(
				'ul',
				{ class: 'choices' },
				suggestions.map((suggestion) =>
					el(
						'li',
						{},
						el(
							'button',
							{
								type: 'button',
								class: 'choice choice--plain',
								onclick: () => {
									$<HTMLInputElement>('#address').value = suggestion.text;
									void runSearch(suggestion.text);
								}
							},
							el('span', { class: 'choice-via' }, [suggestion.street, parsed.number].filter(Boolean).join(' ')),
							el('span', { class: 'choice-area' }, suggestion.area)
						)
					)
				)
			)
		);
	}
	children.push(
		notices.map((text) => el('p', { class: 'result-notice' }, text)),
		el('p', { class: 'result-note' }, 'Revisá calle y altura, agregá el barrio o la localidad, o marcá el punto en el mapa.'),
		el('div', { class: 'result-actions' }, el('button', { type: 'button', class: 'button button--secondary', onclick: startPicking }, 'Marcar en el mapa'))
	);
	showStatus(el('div', { class: 'result result--warning' }, children));
}

function warningBox(text: string): HTMLElement {
	return el('div', { class: 'result result--warning' }, el('p', { class: 'result-title' }, text));
}

function errorBox(query: string): HTMLElement {
	return el(
		'div',
		{ class: 'result result--warning' },
		el('p', { class: 'result-title' }, 'No se pudieron consultar los servicios de direcciones.'),
		el('p', {}, 'Revisá la conexión y volvé a intentar, o marcá el punto en el mapa.'),
		el(
			'div',
			{ class: 'result-actions' },
			el('button', { type: 'button', class: 'button button--primary', onclick: () => void runSearch(query) }, 'Reintentar'),
			el('button', { type: 'button', class: 'button button--secondary', onclick: startPicking }, 'Marcar en el mapa')
		)
	);
}

function startPicking(): void {
	state.picking = true;
	document.body.classList.add('picking');
	showStatus(
		el(
			'div',
			{ class: 'result' },
			el('p', { class: 'result-title' }, 'Tocá el mapa en el lugar del domicilio.'),
			el('div', { class: 'result-actions' }, el('button', { type: 'button', class: 'button button--secondary', onclick: cancelPicking }, 'Cancelar'))
		)
	);
	if (narrowScreen.matches) $('#map').scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
}

function stopPicking(): void {
	state.picking = false;
	document.body.classList.remove('picking');
}

function cancelPicking(): void {
	stopPicking();
	showStatus(state.patient ? locationBox(state.patient, []) : null);
}

/* -------------------------------------------------------------------------- */
/* Admin mode (open the page with #admin)                                      */
/* -------------------------------------------------------------------------- */

function createAdminPanel(): void {
	$('#nodes').append(
		el(
			'section',
			{ class: 'admin', 'aria-labelledby': 'admin-title' },
			el('h2', { id: 'admin-title' }, 'Edición de nodos'),
			el(
				'p',
				{},
				'Arrastrá un nodo en el mapa para corregir su ubicación. Después copiá este JSON y pegalo en public/nodos.json: las coordenadas quedan fijas y el mapa carga más rápido.'
			),
			el('textarea', { id: 'admin-json', rows: 14, readonly: true, spellcheck: 'false', 'aria-label': 'Contenido para nodos.json' }),
			el(
				'div',
				{ class: 'admin-actions' },
				el('button', { type: 'button', class: 'button button--primary', onclick: () => void copyNodesJson() }, 'Copiar JSON'),
				el('button', { type: 'button', class: 'button button--secondary', onclick: forgetCachedNodes }, 'Volver a ubicar nodos'),
				el('span', { id: 'admin-feedback', 'aria-live': 'polite' })
			)
		)
	);
}

function nodesJson(): string {
	const nodes = state.nodes.map((node) => {
		const { lat: _lat, lon: _lon, ...rest } = node.raw;
		return hasPoint(node) ? { ...rest, lat: round6(node.lat), lon: round6(node.lon) } : rest;
	});
	return `${JSON.stringify(nodes, null, 2)}\n`;
}

function updateAdminPanel(): void {
	const area = document.querySelector<HTMLTextAreaElement>('#admin-json');
	if (area) area.value = nodesJson();
}

async function copyNodesJson(): Promise<void> {
	const feedback = $('#admin-feedback');
	try {
		await navigator.clipboard.writeText(nodesJson());
		feedback.textContent = 'JSON copiado.';
	} catch {
		$<HTMLTextAreaElement>('#admin-json').select();
		feedback.textContent = 'Texto seleccionado: copialo con Ctrl+C.';
	}
}

function forgetCachedNodes(): void {
	try {
		localStorage.removeItem(CACHE_KEY);
	} catch {
		// Nothing to forget.
	}
	window.location.reload();
}

/* -------------------------------------------------------------------------- */
/* Startup                                                                     */
/* -------------------------------------------------------------------------- */

async function start(): Promise<void> {
	wireSearchForm();
	try {
		state.nodes = await loadNodes();
	} catch (error) {
		console.error(error);
		$('#list-note').textContent = '';
		showStatus(
			el(
				'div',
				{ class: 'result result--warning' },
				el('p', { class: 'result-title' }, 'No se pudo leer nodos.json.'),
				el('p', {}, 'Revisá que el archivo exista en public/ y que sea un JSON válido.')
			)
		);
		return;
	}
	if (state.admin) createAdminPanel();
	refresh();
	await geocodeNodes();
}

window.addEventListener('hashchange', () => window.location.reload());
void start();
