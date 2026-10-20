import * as duckdb from '@duckdb/duckdb-wasm';

export const COMUNIDADES = [
  { id: 'ES61', nombre: 'Andalucía' }, { id: 'ES24', nombre: 'Aragón' },
  { id: 'ES12', nombre: 'Principado de Asturias' }, { id: 'ES53', nombre: 'Illes Balears' },
  { id: 'ES70', nombre: 'Canarias' }, { id: 'ES13', nombre: 'Cantabria' },
  { id: 'ES41', nombre: 'Castilla y León' }, { id: 'ES42', nombre: 'Castilla-La Mancha' },
  { id: 'ES51', nombre: 'Cataluña' }, { id: 'ES52', nombre: 'Comunidad Valenciana' },
  { id: 'ES43', nombre: 'Extremadura' }, { id: 'ES11', nombre: 'Galicia' },
  { id: 'ES30', nombre: 'Comunidad de Madrid' }, { id: 'ES62', nombre: 'Región de Murcia' },
  { id: 'ES22', nombre: 'Comunidad Foral de Navarra' }, { id: 'ES21', nombre: 'País Vasco' },
  { id: 'ES23', nombre: 'La Rioja' }
];

export const CCAA_COLORS = {
  'ES61': '#4ade80', 'ES24': '#f87171', 'ES12': '#60a5fa', 'ES53': '#c084fc',
  'ES70': '#facc15', 'ES13': '#fb923c', 'ES41': '#a78bfa', 'ES42': '#f472b6',
  'ES51': '#fbbf24', 'ES52': '#38bdf8', 'ES43': '#34d399', 'ES11': '#818cf8',
  'ES30': '#f43f5e', 'ES62': '#fca5a5', 'ES22': '#fdba74', 'ES21': '#10b981',
  'ES23': '#fda4af', 'ES63': '#94a3b8', 'ES64': '#64748b'
};

/**
 * Normaliza las propiedades de una feature soportando tanto el esquema
 * Parquet oficial (area_st, zbs_cd, zbs_st, ccaa_cd) como el esquema GeoJSON legado.
 */
export const normalizeFeatureProperties = (f, index) => {
  const props = { ...(f?.properties || {}) };

  // 1. Área de Salud (prioridad area_st)
  const rawArea = props.area_st || props.AREA_ST || props.area || props.AREA || props.nom_area || props.nombre_area || 'Desconocida';
  
  // 2. Nombre de la ZBS (prioridad zbs_st)
  const rawZbsName = props.zbs_st || props.ZBS_ST || props.n_zbs || props.N_ZBS || props.nom_zbs || `ZBS_ID_${index}`;
  
  // 3. Código de la ZBS (prioridad zbs_cd)
  const rawZbsCode = props.zbs_cd || props.ZBS_CD || props.id_zbs || props.codatzbs || props.CODATZBS || props.cod_zbs || `NEW-${index}`;
  
  // 4. Código CCAA (prioridad ccaa_cd)
  const rawCcaa = props.ccaa_cd || props.CCAA_CD || props.ccaa_id || props.CCAA_ID || '';

  const cleanArea = String(rawArea).trim();
  const cleanZbsName = String(rawZbsName).trim();
  const cleanZbsCode = String(rawZbsCode).replace(/\.0+$/, '').trim();
  const cleanCcaa = String(rawCcaa).trim().toUpperCase();

  return {
    area_st: cleanArea,
    zbs_st: cleanZbsName,
    zbs_cd: cleanZbsCode,
    ccaa_cd: cleanCcaa,
    area_cd: props.area_cd ? String(props.area_cd).trim() : '',
    area_id: props.area_id ? String(props.area_id).trim() : '',
    valid_from: props.valid_from ?? null,
    valid_to: props.valid_to ?? null,
    version: props.version ?? null,
    OGC_FID: props.OGC_FID ?? null,

    // Compatibilidad hacia atrás
    area: cleanArea,
    zbsName: cleanZbsName,
    zbsCode: cleanZbsCode,
    ccaa: cleanCcaa,
    fullProps: {
      ...props,
      area_st: cleanArea,
      zbs_st: cleanZbsName,
      zbs_cd: cleanZbsCode,
      ccaa_cd: cleanCcaa,
      nombre_area_normalizado: cleanArea,
      nombre_zbs_normalizado: `${cleanZbsCode}_${cleanZbsName}`
    }
  };
};

let globalDbInstance = null;

export const initDuckDB = async () => {
  if (globalDbInstance) return globalDbInstance;
  const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
  const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);
  const workerString = `importScripts("${bundle.mainWorker}");`;
  const workerBlob = new Blob([workerString], { type: 'text/javascript' });
  const worker = new Worker(URL.createObjectURL(workerBlob));
  const logger = new duckdb.ConsoleLogger();
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  
  const conn = await db.connect();
  await conn.query('INSTALL spatial; LOAD spatial;');
  await conn.close();
  
  globalDbInstance = db;
  return db;
};

// ============================================================================
// MOTOR DE LIMPIEZA TOPOLÓGICA Y SUPRESIÓN DE POLÍGONOS DIMINUTOS Y LÍNEAS INTERIORES
// ============================================================================

/**
 * Calcula el área planar aproximada (en grados²) de un anillo cerrado
 * utilizando la fórmula del área de Gauss (Shoelace formula).
 */
export function getRingArea(ring) {
  if (!ring || ring.length < 3) return 0;
  let area = 0;
  const len = ring.length;
  for (let i = 0, j = len - 1; i < len; j = i++) {
    const p1 = ring[i];
    const p2 = ring[j];
    if (p1 && p2) {
      area += (p2[0] + p1[0]) * (p2[1] - p1[1]);
    }
  }
  return Math.abs(area / 2);
}

/**
 * Redondea coordenadas a 5 posiciones decimales (~1.1 metros)
 * para forzar que vértices casi colineales colapsen y no dejen micro-fisuras.
 */
function roundCoords(coords) {
  if (!coords) return coords;
  if (typeof coords[0] === 'number') {
    return [
      Math.round(coords[0] * 100000) / 100000,
      Math.round(coords[1] * 100000) / 100000
    ];
  }
  return coords.map(roundCoords);
}

/**
 * Limpia y sanea exhaustivamente la geometría resultante de una unión/disolución:
 * 1. Elimina todos los micro-huecos interiores (interior rings / holes) que son
 *    artefactos de desalineación en las lindes entre ZBS vecinas.
 * 2. Elimina polígonos astilla diminutos (slivers espurios de área < 0.000005 deg² ≈ 5 hectáreas).
 * 3. Preserva únicamente las masas territoriales legítimas e islas geográficas reales.
 * 4. Simplifica a Polygon si solo queda un anillo exterior principal.
 */
export function cleanDissolvedGeometry(geom) {
  if (!geom || !geom.coordinates) return geom;

  // Umbral mínimo de área en deg² para descartar polígonos astilla o micro-huecos de costura
  // 0.000005 deg² ≈ 50.000 m² (5 hectáreas). Las astillas de unión miden entre 10^-8 y 10^-11 deg².
  const SLIVER_MIN_AREA = 0.000005;

  if (geom.type === 'Polygon') {
    const exterior = geom.coordinates[0];
    if (!exterior || exterior.length < 4) return null;

    // Sellar micro-huecos interiores: en la cartografía sanitaria de España las Áreas de Salud
    // son continuas y no poseen huecos de vacío territorial. Descartamos cualquier agujero
    // cuya área sea inferior a 0.02 deg² (~200 km²).
    const validHoles = (geom.coordinates.slice(1) || []).filter(hole => {
      const areaHole = getRingArea(hole);
      return areaHole > 0.02;
    });

    return {
      type: 'Polygon',
      coordinates: [exterior, ...validHoles]
    };
  }

  if (geom.type === 'MultiPolygon') {
    const polyList = geom.coordinates;
    let maxArea = 0;

    // 1. Calcular el área de cada componente poligonal
    const evaluated = polyList.map(poly => {
      const ext = poly[0];
      const a = getRingArea(ext);
      if (a > maxArea) maxArea = a;
      return { poly, area: a };
    });

    // 2. Filtrar polígonos diminutos (slivers producidos al solaparse o separarse lindes ZBS)
    const cleanedPolygons = [];
    for (const item of evaluated) {
      // Si el polígono es un micro-sliver absoluto (< 5 hectáreas), se descarta
      if (item.area < SLIVER_MIN_AREA) continue;

      // Si es inferior al 0.05% de la masa principal y mide menos de 0.0005 deg², se descarta
      if (item.area < 0.0005 && item.area < maxArea * 0.0005) continue;

      const exterior = item.poly[0];
      // Filtrar también los agujeros interiores dentro de cada polígono
      const validHoles = (item.poly.slice(1) || []).filter(hole => getRingArea(hole) > 0.02);

      cleanedPolygons.push([exterior, ...validHoles]);
    }

    // Si todos fueron filtrados por error, rescatar al menos el polígono de mayor superficie
    if (cleanedPolygons.length === 0) {
      const sorted = [...evaluated].sort((a, b) => b.area - a.area);
      if (sorted.length > 0 && sorted[0].poly) {
        cleanedPolygons.push([sorted[0].poly[0]]);
      }
    }

    // Si sólo queda una masa territorial sólida, convertir a Polygon para simplificar la renderización
    if (cleanedPolygons.length === 1) {
      return {
        type: 'Polygon',
        coordinates: cleanedPolygons[0]
      };
    }

    return {
      type: 'MultiPolygon',
      coordinates: cleanedPolygons
    };
  }

  if (geom.type === 'GeometryCollection') {
    const polyGeoms = (geom.geometries || [])
      .filter(g => g.type === 'Polygon' || g.type === 'MultiPolygon')
      .map(cleanDissolvedGeometry)
      .filter(Boolean);

    if (polyGeoms.length === 1) return polyGeoms[0];
    if (polyGeoms.length > 1) {
      const allPolys = [];
      for (const pg of polyGeoms) {
        if (pg.type === 'Polygon') allPolys.push(pg.coordinates);
        else if (pg.type === 'MultiPolygon') allPolys.push(...pg.coordinates);
      }
      return cleanDissolvedGeometry({ type: 'MultiPolygon', coordinates: allPolys });
    }
  }

  return geom;
}

/**
 * Fallback de unión topológica en JavaScript usando el algoritmo de Martínez-Rueda (polygon-clipping).
 * Con limpieza de coordenadas y supresión de astillas y agujeros internos.
 */
function fallbackUnionWithPolygonClipping(featuresByArea) {
  const pc = (typeof window !== 'undefined' && (window.polygonClipping || window.polygon_clipping))
    ? (window.polygonClipping || window.polygon_clipping)
    : null;

  const mergedFeatures = [];
  let areaIdx = 0;

  for (const [, group] of featuresByArea.entries()) {
    areaIdx++;
    const areaName = group.area_st;
    const ccaaCode = group.ccaa_cd;
    const fId = `AREA_${ccaaCode || 'ES'}_${areaIdx}`;

    if (!pc || group.features.length === 1) {
      const single = group.features[0];
      const cleaned = cleanDissolvedGeometry(single.geometry);
      mergedFeatures.push({
        type: 'Feature',
        id: fId,
        properties: {
          feature_id: fId,
          area_st: areaName,
          nombre_area_normalizado: areaName,
          area: areaName,
          ccaa_cd: ccaaCode,
          ccaa_id: ccaaCode,
          area_cd: group.area_cd,
          area_id: group.area_id,
          total_zbs: group.features.length,
          is_area: true
        },
        geometry: cleaned || single.geometry
      });
      continue;
    }

    try {
      // Extraer y redondear coordenadas a 5 decimales para eliminar micro-fisuras previas a la unión
      const polygonList = [];
      for (const feat of group.features) {
        if (!feat.geometry || !feat.geometry.coordinates) continue;
        const rounded = roundCoords(feat.geometry.coordinates);
        if (feat.geometry.type === 'Polygon') {
          polygonList.push(rounded);
        } else if (feat.geometry.type === 'MultiPolygon') {
          for (const poly of rounded) {
            polygonList.push(poly);
          }
        }
      }

      if (polygonList.length === 0) continue;

      // Unión booleana 2D incremental o en lote
      let unionResult = null;
      try {
        unionResult = pc.union(polygonList[0], ...polygonList.slice(1));
      } catch (_) {
        // En caso de conflicto de índices, acumular sucesivamente
        let acc = polygonList[0];
        for (let k = 1; k < polygonList.length; k++) {
          try {
            acc = pc.union(acc, polygonList[k]);
          } catch (e) {
            // Continuar con los restantes
          }
        }
        unionResult = acc;
      }

      const geomType = unionResult.length === 1 ? 'Polygon' : 'MultiPolygon';
      const coords = unionResult.length === 1 ? unionResult[0] : unionResult;

      // Saneamiento de astillas y agujeros internos
      const cleaned = cleanDissolvedGeometry({ type: geomType, coordinates: coords });

      mergedFeatures.push({
        type: 'Feature',
        id: fId,
        properties: {
          feature_id: fId,
          area_st: areaName,
          nombre_area_normalizado: areaName,
          area: areaName,
          ccaa_cd: ccaaCode,
          ccaa_id: ccaaCode,
          area_cd: group.area_cd,
          area_id: group.area_id,
          total_zbs: group.features.length,
          is_area: true
        },
        geometry: cleaned
      });
    } catch (pcErr) {
      console.warn(`Fallback de emergencia para el área "${areaName}" (${ccaaCode}):`, pcErr);
      const allCoords = [];
      for (const feat of group.features) {
        if (!feat.geometry) continue;
        if (feat.geometry.type === 'Polygon') allCoords.push(feat.geometry.coordinates);
        else if (feat.geometry.type === 'MultiPolygon') allCoords.push(...feat.geometry.coordinates);
      }
      const rawFallback = { type: 'MultiPolygon', coordinates: allCoords };
      mergedFeatures.push({
        type: 'Feature',
        id: fId,
        properties: {
          feature_id: fId,
          area_st: areaName,
          nombre_area_normalizado: areaName,
          area: areaName,
          ccaa_cd: ccaaCode,
          ccaa_id: ccaaCode,
          area_cd: group.area_cd,
          area_id: group.area_id,
          total_zbs: group.features.length,
          is_area: true
        },
        geometry: cleanDissolvedGeometry(rawFallback) || rawFallback
      });
    }
  }

  return mergedFeatures;
}

/**
 * Fusiona y disuelve geometrías agrupándolas conjuntamente por `ccaa_cd` y `area_st`.
 * Elimina polígonos diminutos y líneas interiores espurias mediante
 * saneamiento posterior a la unión en DuckDB Spatial y fallback de Martínez-Rueda.
 */
export const runDuckDBFusion = async (features, prefix = 'data') => {
  if (!features || features.length === 0) return [];

  // Organizar features por ccaa_cd y area_st para contingencias
  const featuresByArea = new Map();
  for (const f of features) {
    const p = f.properties || {};
    const areaName = String(p.area_st || p.nombre_area_normalizado || p.area || 'Desconocida').trim();
    const ccaaCode = String(p.ccaa_cd || p.ccaa_id || '').trim();
    const groupKey = `${ccaaCode}__${areaName}`;

    if (!featuresByArea.has(groupKey)) {
      featuresByArea.set(groupKey, {
        area_st: areaName,
        ccaa_cd: ccaaCode,
        area_cd: String(p.area_cd || '').trim(),
        area_id: String(p.area_id || '').trim(),
        features: []
      });
    }
    featuresByArea.get(groupKey).features.push(f);
  }

  let db = null;
  let conn = null;
  const fileName = `${prefix}_${Date.now()}.geojson`;

  try {
    db = await initDuckDB();
    conn = await db.connect();

    const sanitizedFeatures = features.map((f) => {
      const p = f.properties || {};
      const areaSt = p.area_st || p.nombre_area_normalizado || p.area || 'Desconocida';
      const ccaaCd = p.ccaa_cd || p.ccaa_id || '';
      const areaCd = p.area_cd || '';
      const areaId = p.area_id || '';
      const zbsName = p.zbs_st || p.n_zbs || p.zbs_cd || '';

      return {
        type: 'Feature',
        geometry: f.geometry,
        properties: {
          area_st: String(areaSt).trim(),
          ccaa_cd: String(ccaaCd).trim(),
          area_cd: String(areaCd).trim(),
          area_id: String(areaId).trim(),
          zbs_st: String(zbsName).trim()
        }
      };
    });

    await db.registerFileText(fileName, JSON.stringify({ type: 'FeatureCollection', features: sanitizedFeatures }));

    const query = `
      WITH valid_geoms AS (
        SELECT 
          ccaa_cd,
          area_st,
          area_cd,
          area_id,
          zbs_st,
          ST_MakeValid(geom) AS geom_clean
        FROM ST_Read('${fileName}')
        WHERE geom IS NOT NULL
          AND area_st IS NOT NULL 
          AND area_st != ''
          AND ST_GeometryType(geom) IN ('POLYGON', 'MULTIPOLYGON', 'Polygon', 'MultiPolygon')
      )
      SELECT 
        ccaa_cd,
        area_st,
        MAX(area_cd) AS area_cd,
        MAX(area_id) AS area_id,
        COUNT(zbs_st) AS total_zbs,
        STRING_AGG(zbs_st, ', ') AS zbs_list,
        ST_AsGeoJSON(
          ST_MakeValid(
            ST_Union_Agg(geom_clean)
          )
        ) AS geometry
      FROM valid_geoms
      GROUP BY ccaa_cd, area_st
    `;

    const result = await conn.query(query);

    return result.toArray().map((row, idx) => {
      let rawGeom = null;
      try {
        rawGeom = JSON.parse(row.geometry);
      } catch (err) {
        console.warn('Fallo al parsear geometría GeoJSON desde DuckDB:', err);
      }

      // Saneamiento de micro-huecos y polígonos astilla residuales
      const geom = cleanDissolvedGeometry(rawGeom);

      const areaName = String(row.area_st || 'Desconocida').trim();
      const ccaaCode = String(row.ccaa_cd || '').trim();
      const fId = `AREA_${ccaaCode || 'ES'}_${idx + 1}`;

      return {
        type: 'Feature',
        id: fId,
        properties: {
          feature_id: fId,
          area_st: areaName,
          nombre_area_normalizado: areaName,
          area: areaName,
          ccaa_cd: ccaaCode,
          ccaa_id: ccaaCode,
          area_cd: row.area_cd ? String(row.area_cd).trim() : '',
          area_id: row.area_id ? String(row.area_id).trim() : '',
          total_zbs: row.total_zbs ? Number(row.total_zbs) : 1,
          zbs_incluidas: row.zbs_list ? String(row.zbs_list) : '',
          is_area: true
        },
        geometry: geom
      };
    });
  } catch (err) {
    console.warn('DuckDB GEOS TopologyException detectado. Activando fallback tolerante a fallos con polygon-clipping:', err);
    return fallbackUnionWithPolygonClipping(featuresByArea);
  } finally {
    if (conn) {
      try { await conn.close(); } catch (_) {}
    }
    if (db) {
      try { await db.dropFile(fileName); } catch (_) {}
    }
  }
};

/**
 * Fusión directa nativa en SQL sobre el fichero Parquet agrupando por ccaa_cd y area_st.
 */
export const runDuckDBParquetAreaFusion = async (conn, parquetFileName, targetYearInt, ccaaFilterList) => {
  if (!conn || !parquetFileName || !ccaaFilterList) return [];

  const sqlAreasQuery = `
    WITH active_zbs AS (
      SELECT 
        CAST(ccaa_cd AS VARCHAR) as ccaa_cd,
        CAST(area_cd AS VARCHAR) as area_cd,
        CAST(area_id AS VARCHAR) as area_id,
        CAST(area_st AS VARCHAR) as area_st,
        CAST(zbs_st AS VARCHAR) as zbs_st,
        ST_MakeValid(geom) as geom_clean
      FROM read_parquet('${parquetFileName}')
      WHERE ccaa_cd IN (${ccaaFilterList})
        AND area_st IS NOT NULL
        AND TRIM(CAST(area_st AS VARCHAR)) NOT IN ('', 'None', 'null', 'NULL', 'Desconocida')
        AND (
          valid_from IS NULL 
          OR TRIM(CAST(valid_from AS VARCHAR)) IN ('', 'None', 'null', 'NULL')
          OR TRY_CAST(SUBSTR(CAST(valid_from AS VARCHAR), 1, 4) AS INT) <= ${targetYearInt}
        )
        AND (
          valid_to IS NULL 
          OR TRIM(CAST(valid_to AS VARCHAR)) IN ('', 'None', 'null', 'NULL')
          OR TRY_CAST(SUBSTR(CAST(valid_to AS VARCHAR), 1, 4) AS INT) > ${targetYearInt}
        )
        AND ST_GeometryType(geom) IN ('POLYGON', 'MULTIPOLYGON', 'Polygon', 'MultiPolygon')
    )
    SELECT 
      ccaa_cd,
      area_st,
      MAX(area_cd) as area_cd,
      MAX(area_id) as area_id,
      COUNT(zbs_st) as total_zbs,
      ST_AsGeoJSON(
        ST_MakeValid(
          ST_Union_Agg(geom_clean)
        )
      ) as geometry
    FROM active_zbs
    GROUP BY ccaa_cd, area_st
  `;

  const queryResult = await conn.query(sqlAreasQuery);
  const rows = queryResult.toArray();

  return rows.map((row, idx) => {
    let rawGeom = null;
    if (row.geometry) {
      try {
        rawGeom = JSON.parse(row.geometry);
      } catch (_) {}
    }

    const geom = cleanDissolvedGeometry(rawGeom);
    const areaName = String(row.area_st || 'Desconocida').trim();
    const ccaaCode = String(row.ccaa_cd || '').trim();
    const fId = `AREA_${ccaaCode || 'ES'}_${idx + 1}`;

    return {
      type: 'Feature',
      id: fId,
      properties: {
        feature_id: fId,
        area_st: areaName,
        nombre_area_normalizado: areaName,
        area: areaName,
        ccaa_cd: ccaaCode,
        ccaa_id: ccaaCode,
        area_cd: row.area_cd ? String(row.area_cd).trim() : '',
        area_id: row.area_id ? String(row.area_id).trim() : '',
        total_zbs: row.total_zbs ? Number(row.total_zbs) : 1,
        is_area: true
      },
      geometry: geom
    };
  });
};

// AUDITORÍA ESPACIAL COMPLETA
export const runSpatialAudit = async (baseFeats, upFeats) => {
  if (!baseFeats.length || !upFeats.length) return { matches: [], modified: [] };
  const db = await initDuckDB();
  const conn = await db.connect();
  const fBase = `base_${Date.now()}.geojson`;
  const fUp = `up_${Date.now()}.geojson`;
  
  try {
    await db.registerFileText(fBase, JSON.stringify({ type: "FeatureCollection", features: baseFeats }));
    await db.registerFileText(fUp, JSON.stringify({ type: "FeatureCollection", features: upFeats }));
    
    const qMatches = `
      WITH base_deleted AS (
        SELECT 
          COALESCE(properties->>'zbs_cd', properties->>'codatzbs') as cod,
          COALESCE(properties->>'zbs_st', properties->>'n_zbs') as nom,
          geom 
        FROM ST_Read('${fBase}')
        WHERE COALESCE(properties->>'zbs_cd', properties->>'codatzbs') NOT IN (
          SELECT COALESCE(properties->>'zbs_cd', properties->>'codatzbs') FROM ST_Read('${fUp}')
        )
      ),
      up_added AS (
        SELECT 
          COALESCE(properties->>'zbs_cd', properties->>'codatzbs') as cod,
          COALESCE(properties->>'zbs_st', properties->>'n_zbs') as nom,
          geom 
        FROM ST_Read('${fUp}')
        WHERE COALESCE(properties->>'zbs_cd', properties->>'codatzbs') NOT IN (
          SELECT COALESCE(properties->>'zbs_cd', properties->>'codatzbs') FROM ST_Read('${fBase}')
        )
      )
      SELECT b.cod as elimCod, b.nom as elimNom, u.cod as newCod, u.nom as newNom
      FROM base_deleted b JOIN up_added u
      ON ST_Intersects(ST_Centroid(ST_MakeValid(b.geom)), ST_MakeValid(u.geom)) 
         OR ST_Intersects(ST_Centroid(ST_MakeValid(u.geom)), ST_MakeValid(b.geom))
    `;
    const resMatches = await conn.query(qMatches);
    const matches = resMatches.toArray().map(r => ({ elimCod: r.elimCod, elimNom: r.elimNom, newCod: r.newCod, newNom: r.newNom }));

    const qModified = `
      SELECT 
        b.properties->>'codatzbs' as cod, 
        b.properties->>'n_zbs' as nom
      FROM ST_Read('${fBase}') b JOIN ST_Read('${fUp}') u 
        ON COALESCE(b.properties->>'zbs_cd', b.properties->>'codatzbs') = COALESCE(u.properties->>'zbs_cd', u.properties->>'codatzbs')
      WHERE ST_Area(ST_Difference(ST_MakeValid(b.geom), ST_MakeValid(u.geom))) > 0.00001
         OR ST_Area(ST_Difference(ST_MakeValid(u.geom), ST_MakeValid(b.geom))) > 0.00001
    `;
    const resMod = await conn.query(qModified);
    const modified = resMod.toArray().map(r => ({ cod: r.cod, nom: r.nom }));

    return { matches, modified };
  } catch (e) {
    console.error("Error en auditoría espacial:", e);
    return { matches: [], modified: [] };
  } finally {
    if (conn) await conn.close();
    if (db) {
      try { await db.dropFile(fBase); } catch (_) {}
      try { await db.dropFile(fUp); } catch (_) {}
    }
  }
};