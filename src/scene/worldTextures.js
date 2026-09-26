/**
 * Paints exoplanet and star surfaces on the GPU, once, when a system opens.
 *
 * Each world is baked into equirectangular maps laid out exactly as three's
 * SphereGeometry samples them, so the planets are drawn by the same materials,
 * lights, bump mapping and cloud shells as the Solar System's. The painting is
 * 3D noise evaluated on the unit sphere, never 2D noise on the map, so there is
 * no seam at the date line and nothing pinches at the poles.
 *
 * Two maps per planet:
 *   colour  sRGB albedo (the hardware encodes it; the shader writes linear)
 *   data    R height (bump), G cloud cover (the cloud shell's alphaMap reads
 *           G), B heat (0 cold to 1 hottest; see exoplanetSurface.js), A how
 *           shiny (seas and ice)
 * Stars get one data map: two granulation fields, spots and faculae.
 *
 * What to paint comes from src/data/worlds.js.
 */

import * as THREE from 'three';

const NOISE = /* glsl */ `
  #define PI 3.141592653589793

  // Always 0, but the compiler cannot know that, so every loop that starts
  // from it stays a loop. Direct3D's compiler (Chrome and Edge on Windows)
  // would otherwise unroll them all, and took 4 to 13 seconds over each kind
  // of world, with the page frozen throughout.
  uniform int uZero;

  // PCG3D (Jarzynski & Olano 2020): a good integer hash, no sin() artefacts.
  uvec3 pcg3d( uvec3 v ) {
    v = v * 1664525u + 1013904223u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    v ^= v >> 16u;
    v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
    return v;
  }
  vec3 hash3( vec3 p ) {
    return vec3( pcg3d( uvec3( ivec3( floor( p ) ) + 32768 ) ) ) * ( 1.0 / 4294967295.0 );
  }
  vec3 gradient( vec3 cell ) { return normalize( hash3( cell ) * 2.0 - 1.0 + 1e-5 ); }

  // Gradient (Perlin) noise with a quintic fade, roughly in [-1, 1].
  float noise( vec3 p ) {
    vec3 i = floor( p ), f = p - i;
    vec3 u = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
    // Corner k is ( k & 1, k >> 1 & 1, k >> 2 ): n[ 0 ] is n000, n[ 1 ] n100, ...
    float n[ 8 ];
    for ( int k = uZero; k < 8; k++ ) {
      vec3 c = vec3( k & 1, ( k >> 1 ) & 1, k >> 2 );
      n[ k ] = dot( gradient( i + c ), f - c );
    }
    return 1.6 * mix(
      mix( mix( n[ 0 ], n[ 1 ], u.x ), mix( n[ 2 ], n[ 3 ], u.x ), u.y ),
      mix( mix( n[ 4 ], n[ 5 ], u.x ), mix( n[ 6 ], n[ 7 ], u.x ), u.y ), u.z );
  }

  // Octaves are rotated against each other so their lattices never line up.
  const mat3 TURN = mat3( 0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64 );
  float fbm( vec3 p, int octaves ) {
    float sum = 0.0, amplitude = 0.5, norm = 0.0;
    for ( int i = uZero; i < octaves; i++ ) {
      sum += amplitude * noise( p ); norm += amplitude;
      p = TURN * p * 2.03; amplitude *= 0.5;
    }
    return sum / norm;
  }
  // Sharp crests, each octave weighted by the one before: mountain ranges.
  float ridged( vec3 p, int octaves ) {
    float sum = 0.0, amplitude = 0.5, weight = 1.0, norm = 0.0;
    for ( int i = uZero; i < octaves; i++ ) {
      float n = 1.0 - abs( noise( p ) );
      n *= n * weight;
      weight = clamp( n * 1.6, 0.0, 1.0 );
      sum += amplitude * n; norm += amplitude;
      p = TURN * p * 2.1; amplitude *= 0.5;
    }
    return sum / norm;
  }
  // The kth of the 27 cells round and including p's, x fastest: one loop, not three.
  vec3 neighbour( int k ) { return vec3( k % 3, ( k / 3 ) % 3, k / 9 ) - 1.0; }
  // Worley cells: distances to the nearest and second-nearest feature point.
  vec2 cells( vec3 p ) {
    vec3 i = floor( p ), f = p - i;
    float d1 = 8.0, d2 = 8.0;
    for ( int k = uZero; k < 27; k++ ) {
      vec3 c = neighbour( k );
      vec3 r = c + hash3( i + c ) * 0.9 + 0.05 - f;
      float d = dot( r, r );
      if ( d < d1 ) { d2 = d1; d1 = d; } else if ( d < d2 ) d2 = d;
    }
    return sqrt( vec2( d1, d2 ) );
  }
  // Bowl-shaped craters with raised rims, at most one per cell.
  float craters( vec3 p ) {
    vec3 i = floor( p ), f = p - i;
    float h = 0.0;
    for ( int k = uZero; k < 27; k++ ) {
      vec3 c = neighbour( k );
      vec3 r = hash3( i + c + 17.0 );
      if ( r.z > 0.6 ) continue;
      float radius = 0.16 + 0.3 * r.x * r.x;
      float d = length( c + hash3( i + c ) * 0.7 + 0.15 - f ) / radius;
      if ( d > 1.8 ) continue;
      float bowl = d < 1.0 ? d * d - 1.0 : 0.0;
      float rim = exp( -pow( ( d - 1.0 ) / 0.25, 2.0 ) ) * 0.4;
      h += ( bowl * 0.9 + rim ) * radius;
    }
    return h;
  }
  vec3 turnAbout( vec3 v, vec3 axis, float angle ) {
    float c = cos( angle ), s = sin( angle );
    return v * c + cross( axis, v ) * s + axis * dot( axis, v ) * ( 1.0 - c );
  }
  // A texel of an equirectangular map as three's SphereGeometry lays it out:
  // u = 0.5 is local +X (longitude 0), v = 1 the north pole.
  vec3 sphereDirection( vec2 uv ) {
    float phi = uv.x * 2.0 * PI, theta = ( 1.0 - uv.y ) * PI;
    return vec3( -cos( phi ) * sin( theta ), cos( theta ), sin( phi ) * sin( theta ) );
  }
  // Four colours along t, dark to light.
  vec3 ramp( vec3 a, vec3 b, vec3 c, vec3 d, float t ) {
    t = clamp( t, 0.0, 1.0 );
    return t < 0.4 ? mix( a, b, t / 0.4 ) : t < 0.8 ? mix( b, c, ( t - 0.4 ) / 0.4 ) : mix( c, d, ( t - 0.8 ) / 0.2 );
  }
`;

const PLANET = /* glsl */ `
  uniform vec3 uOffset;
  uniform vec3 uPalette[ 4 ];
  uniform vec3 uOcean[ 2 ];
  // frequency, contrast, turbulence, stretch
  uniform vec4 uBands;
  // chevron, west clouds, storm count, ice-giant dark spots
  uniform vec4 uBands2;
  uniform vec4 uStorms[ 4 ];
  // craters, roughness, sea fraction, ice (cap latitude, or the open sea's radius on an eyeball world)
  uniform vec4 uTerrain;
  // lava sea radius, cracks, cloud cover, heat shift east
  uniform vec4 uTerrain2;
  // has heat, heat is uniform (self-luminous), -, -
  uniform vec4 uHeat;

  varying vec2 vUv;
  // One map per pass: the colour, or with DATA defined the data, and the
  // compiler drops whatever the other needs. Both at once, to two targets,
  // would be cheaper to draw, but Chrome on Windows compiles such a shader a
  // second time at its first draw, with the page stopped until it is done.
  out vec4 outMap;

  // The point under the star on a tidally locked planet, and where the heat
  // peaks: east of it, toward local -Z (the way the planet turns).
  const vec3 SUBSTELLAR = vec3( 1.0, 0.0, 0.0 );

  #ifdef GAS
    float stormMask = 0.0;
    // Belts and zones: latitude, warped by turbulence stretched along the
    // flow, swirled round any storms.
    float bands( vec3 d, out float detail, out float flow ) {
      for ( int i = uZero; i < 4; i++ ) {
        if ( float( i ) >= uBands2.z ) break;
        vec3 c = uStorms[ i ].xyz;
        float r = uStorms[ i ].w;
        vec3 delta = d - c;
        delta.y *= 1.9; // ovals, longer east-west
        float dist = length( delta );
        float swirl = exp( -pow( dist / r, 2.0 ) );
        // Anticyclones: clockwise in the north, anticlockwise in the south.
        d = normalize( turnAbout( d, c, -sign( c.y ) * swirl * 3.0 ) );
        stormMask = max( stormMask, smoothstep( r * 0.95, r * 0.55, dist ) );
      }
      vec3 q = d * vec3( 1.0, uBands.w, 1.0 );
      float turbulence = 0.4 + 0.6 * uBands.z;
      float warp = fbm( q * 1.7 + uOffset, 5 );
      float warp2 = fbm( q * 4.3 + uOffset * 1.3 + warp * 1.5, 5 );
      // Eddies are rounder than the bands: less stretched, and folded twice.
      vec3 e = d * vec3( 1.0, 0.35 * uBands.w + 0.65, 1.0 );
      float eddy = fbm( e * 9.0 + uOffset * 0.7 + vec3( warp2 * 2.0, warp * 1.5, 0.0 ), 5 );
      detail = fbm( e * 22.0 + uOffset * 1.1 + vec3( eddy * 2.5 ), 4 );
      float lat = d.y + turbulence * ( 0.07 * warp + 0.035 * warp2 + 0.02 * eddy + 0.006 * detail );
      // Venus-like chevrons: the flow outruns the planet at the equator.
      lat += uBands2.x * 0.08 * abs( d.z );
      flow = lat;
      float f = uBands.x;
      float wobble = noise( vec3( lat * f * 0.35, uOffset.x, 1.7 ) );
      float b = 0.34 * sin( lat * f + uOffset.y + wobble * 2.2 ) + 0.18 * noise( vec3( lat * f * 1.3, uOffset.z, 4.1 ) );
      // Fine streaks drawn out along the flow.
      float streak = fbm( d * vec3( 28.0, 28.0 * uBands.w * 1.6, 28.0 ) + uOffset * 1.9 + vec3( eddy * 1.5 ), 3 );
      // Contrast applies to the belts and zones; the weather within them stays.
      b = 0.5 + b * uBands.y + turbulence * ( 0.15 * eddy + 0.08 * detail + 0.07 * streak );
      // Toward the poles the banding breaks up into mottled haze.
      float polar = smoothstep( 0.72, 0.96, abs( d.y ) );
      b = mix( b, 0.42 + 0.12 * warp2 + 0.1 * eddy, polar * 0.8 );
      return clamp( b, 0.0, 1.0 );
    }
  #endif

  #ifdef ROCK
    float seaLevel() { return ( uTerrain.z - 0.5 ) * 0.62; }
    float height( vec3 d ) {
      float continents = fbm( d * 1.5 + uOffset, 6 );
      float ranges = ridged( d * 4.5 + uOffset * 1.7, 6 );
      float h = continents * 0.62 + ( ranges - 0.45 ) * 0.34 * uTerrain.y * smoothstep( -0.25, 0.3, continents )
        + fbm( d * 22.0 + uOffset, 4 ) * 0.05;
      h += uTerrain.x * ( craters( d * 3.2 + uOffset ) * 0.9 + craters( d * 8.5 + uOffset * 1.9 ) * 0.45
        + craters( d * 21.0 + uOffset * 2.7 ) * 0.2 );
      return h;
    }
    // Ice: polar caps, or on an eyeball world everything but a sea under the star.
    float iceCover( vec3 d, float h, float wobble ) {
      #ifdef EYEBALL
        float angle = acos( clamp( dot( d, SUBSTELLAR ), -1.0, 1.0 ) );
        return smoothstep( uTerrain.w - 0.08, uTerrain.w + 0.1, angle + wobble * 0.25 );
      #else
        float lat = abs( d.y ) + wobble * 0.08 + max( h - seaLevel() - 0.25, 0.0 ) * 0.5;
        return smoothstep( uTerrain.w - 0.04, uTerrain.w + 0.04, lat );
      #endif
    }
  #endif

  float clouds( vec3 d ) {
    vec3 q = d * vec3( 1.0, 1.7, 1.0 );
    float warp = fbm( q * 2.2 + uOffset * 0.7, 4 );
    float c = fbm( q * 3.6 + vec3( warp * 1.4 ) + uOffset * 1.9, 6 );
    // Rising air: a band of cloud on the equator and storm tracks at mid latitudes.
    float lat = abs( d.y );
    c += 0.1 * ( 1.0 - smoothstep( 0.0, 0.18, lat ) ) + 0.08 * smoothstep( 0.45, 0.7, lat ) - 0.08 * smoothstep( 0.2, 0.35, lat ) * ( 1.0 - smoothstep( 0.35, 0.5, lat ) );
    #ifdef EYEBALL
      // Tidally locked: a standing tower of cloud over the point under the star.
      c += 0.35 * smoothstep( 0.55, 0.95, dot( d, SUBSTELLAR ) );
    #endif
    // fbm sits near 0.5 ± 0.1 here, so this threshold covers about the asked fraction.
    float threshold = 0.5 + ( 0.5 - uTerrain2.z ) * 0.22;
    return smoothstep( threshold - 0.03, threshold + 0.09, c * 0.5 + 0.5 ) * 0.95;
  }

  // Heat, 0 at the coldest the map shows to 1 at the hottest.
  float heat( vec3 d, float texture_ ) {
    if ( uHeat.x < 0.5 ) return 0.0;
    if ( uHeat.y > 0.5 ) return clamp( 0.55 + 0.45 * texture_, 0.0, 1.0 );
    vec3 hot = vec3( cos( uTerrain2.w ), 0.0, -sin( uTerrain2.w ) );
    float x = dot( d, hot );
    return pow( clamp( x * 0.8 + 0.2, 0.0, 1.0 ), 0.6 ) * ( 0.88 + 0.12 * texture_ );
  }

  void main() {
    vec3 d = sphereDirection( vUv );
    vec3 colour;
    vec4 data = vec4( 0.5, 0.0, 0.0, 0.0 );

    #ifdef GAS
      float detail, flow;
      float b = bands( d, detail, flow );
      colour = ramp( uPalette[ 0 ], uPalette[ 1 ], uPalette[ 2 ], mix( uPalette[ 2 ], vec3( 1.0 ), 0.25 ), b );
      // Some bands pick up the accent colour, as Jupiter's belts go brown and red.
      float accent = smoothstep( 0.25, 0.7, noise( vec3( flow * uBands.x * 0.5, uOffset.z * 2.0, 3.3 ) ) );
      colour = mix( colour, uPalette[ 3 ], accent * 0.35 * ( 1.0 - b ) );
      colour = mix( colour, uPalette[ 3 ], stormMask * 0.8 );
      if ( uBands2.w > 0.5 ) colour = mix( colour, uPalette[ 0 ] * 0.7, stormMask );
      // Clouds that form on the cooler morning (west, +Z) side of a hot Jupiter's day.
      float west = uBands2.y * smoothstep( 0.05, 0.7, d.z ) * smoothstep( -0.4, 0.2, d.x )
        * smoothstep( 0.35, 0.7, fbm( d * 5.0 + uOffset, 5 ) * 0.5 + 0.5 + 0.2 );
      colour = mix( colour, vec3( 0.62, 0.6, 0.58 ), west );
      data.b = heat( d, b ) * ( 1.0 - 0.6 * west );
    #endif

    #ifdef ROCK
      float h = height( d );
      float wobble = fbm( d * 6.0 + uOffset * 3.1, 4 );
      float grain = fbm( d * 40.0 + uOffset, 3 );
      float t = clamp( h * 1.3 + 0.45 + wobble * 0.25, 0.0, 1.0 );
      colour = ramp( uPalette[ 0 ], uPalette[ 1 ], uPalette[ 2 ], uPalette[ 3 ], t * 0.85 ) * ( 0.94 + 0.12 * grain );
      data.r = clamp( h * 0.5 + 0.5, 0.0, 1.0 );

      #if defined( TEMPERATE ) || defined( EYEBALL )
        float level = seaLevel();
        // Land from lowland to highland, without the ramp's top (ice) colour.
        colour = ramp( uPalette[ 0 ], uPalette[ 1 ], uPalette[ 2 ], uPalette[ 2 ] * 1.1, clamp( ( h - level ) * 1.6 + 0.35 + wobble * 0.2, 0.0, 1.0 ) ) * ( 0.94 + 0.12 * grain );
        if ( h < level ) {
          colour = mix( uOcean[ 0 ], uOcean[ 1 ], smoothstep( level - 0.14, level, h ) );
          data.r = clamp( level * 0.5 + 0.5, 0.0, 1.0 );
          data.a = 1.0;
        }
        float ice = iceCover( d, h, wobble );
        colour = mix( colour, uPalette[ 3 ] * ( 0.92 + 0.08 * grain ), ice );
        data.a = mix( data.a, 0.3, ice );
        data.g = clouds( d );
      #endif

      #ifdef ICE
        // Long, wandering fractures like Europa's lineae: the zero crossings
        // of a few warped noise fields, at different scales.
        vec3 q = d + 0.12 * vec3( fbm( d * 3.0 + uOffset, 3 ), fbm( d * 3.0 + uOffset + 7.0, 3 ), fbm( d * 3.0 + uOffset + 13.0, 3 ) );
        float cracks = ( 1.0 - smoothstep( 0.0, 0.03, abs( noise( q * 3.0 + uOffset ) ) ) ) * 0.9
          + ( 1.0 - smoothstep( 0.0, 0.025, abs( noise( q * 6.5 + uOffset * 1.7 ) ) ) ) * 0.6
          + ( 1.0 - smoothstep( 0.0, 0.02, abs( noise( q * 14.0 + uOffset * 2.3 ) ) ) ) * 0.35;
        cracks *= uTerrain2.y * smoothstep( -0.3, 0.2, wobble );
        colour = mix( ramp( uPalette[ 0 ], uPalette[ 1 ], uPalette[ 2 ], uPalette[ 2 ], t + 0.25 ), uPalette[ 3 ], clamp( cracks, 0.0, 1.0 ) * 0.75 );
        data.r = clamp( data.r - cracks * 0.08, 0.0, 1.0 );
        data.a = 0.35 * ( 1.0 - cracks );
        data.g = clouds( d );
      #endif

      #ifdef LAVA
        // Wandering fissures (noise zero crossings, as on the ice worlds).
        vec3 q = d + 0.1 * vec3( fbm( d * 3.0 + uOffset, 3 ), fbm( d * 3.0 + uOffset + 5.0, 3 ), fbm( d * 3.0 + uOffset + 9.0, 3 ) );
        float cracks = max( 1.0 - smoothstep( 0.0, 0.035, abs( noise( q * 4.0 + uOffset ) ) ),
          ( 1.0 - smoothstep( 0.0, 0.025, abs( noise( q * 10.0 + uOffset * 1.3 ) ) ) ) * 0.6 );
        cracks *= uTerrain2.y * smoothstep( -0.3, 0.2, wobble );
        // A magma sea wherever the ground under the star is above melting,
        // crusted over in drifting plates, brightest where they part.
        float angle = acos( clamp( dot( d, SUBSTELLAR ), -1.0, 1.0 ) );
        float sea = smoothstep( uTerrain2.x + 0.06, uTerrain2.x - 0.12, angle + wobble * 0.3 + max( h, 0.0 ) * 0.4 );
        float hotness = pow( max( dot( d, SUBSTELLAR ), 0.0 ), 0.25 );
        vec2 plates = cells( q * 7.0 + uOffset * 0.7 );
        float crust = smoothstep( 0.04, 0.16, plates.y - plates.x ) * smoothstep( 0.95, 0.6, hotness + 0.15 * wobble );
        colour = mix( colour, vec3( 0.03, 0.02, 0.018 ), max( cracks, sea * 0.9 ) );
        colour = mix( colour, uPalette[ 1 ] * 0.6, sea * crust * 0.8 );
        data.r = mix( data.r, 0.35 + 0.08 * crust, sea );
        float magma = sea * ( 0.5 + 0.5 * hotness ) * ( 1.0 - 0.75 * crust ) * ( 0.85 + 0.15 * grain );
        data.b = max( magma, cracks * ( 0.6 + 0.3 * hotness ) );
        data.a = sea * 0.5 * ( 1.0 - crust );
      #endif
    #endif

    #ifdef DATA
      outMap = data;
    #else
      outMap = vec4( colour, 1.0 );
    #endif
  }
`;

const STAR = /* glsl */ `
  uniform vec3 uOffset;
  // granule frequency, spot cover, polar spots, -
  uniform vec4 uStar;
  varying vec2 vUv;
  layout( location = 0 ) out vec4 outData;

  float granulation( vec3 d, vec3 offset ) {
    vec2 f = cells( d * uStar.x + offset );
    // Bright cell centres with dark lanes between them, and a second, finer
    // set for texture.
    float cell = smoothstep( 0.0, 0.32, f.y - f.x );
    vec2 g = cells( d * uStar.x * 2.3 + offset * 1.7 );
    float fine = smoothstep( 0.0, 0.3, g.y - g.x );
    return clamp( 0.18 + 0.62 * cell + 0.2 * fine + 0.08 * hash3( floor( d * uStar.x + offset ) ).x, 0.0, 1.0 );
  }

  void main() {
    vec3 d = sphereDirection( vUv );
    float a = granulation( d, uOffset );
    float b = granulation( d, uOffset + 31.7 );

    // Spots gather in active latitudes, or anywhere at all on an M dwarf.
    float n = fbm( d * 4.0 + uOffset * 0.5, 5 ) + 0.35 * fbm( d * 12.0 + uOffset, 3 );
    float lat = abs( d.y );
    float band = uStar.z > 0.5 ? 1.0 : smoothstep( 0.05, 0.15, lat ) * ( 1.0 - smoothstep( 0.45, 0.62, lat ) );
    float threshold = mix( 0.6, 0.0, sqrt( uStar.y ) );
    float penumbra = smoothstep( threshold, threshold + 0.07, n ) * band;
    float umbra = smoothstep( threshold + 0.09, threshold + 0.15, n ) * band;
    float spots = uStar.y > 0.0 ? penumbra * 0.5 + umbra * 0.5 : 0.0;

    // Faculae: a bright network round the supergranules and near spots.
    vec2 s = cells( d * uStar.x * 0.22 + uOffset * 0.3 );
    float network = 1.0 - smoothstep( 0.0, 0.12, s.y - s.x );
    float plage = smoothstep( threshold - 0.25, threshold, n ) * band * ( 1.0 - penumbra );
    outData = vec4( a, b, spots, clamp( network * 0.5 + plage * 0.8, 0.0, 1.0 ) );
  }
`;

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4( position.xy, 0.0, 1.0 );
  }
`;

/**
 * Map widths: 2048, or half that on phones to keep memory and the one-off bake
 * cheap. A software renderer (no GPU, or one it won't use) gets a quarter:
 * the noise is the whole cost of the bake, and on the CPU it is slow.
 */
function mapWidth(renderer) {
  const gl = renderer.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
  if (/SwiftShader|llvmpipe|softpipe|Software/i.test(name)) return 512;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const small = typeof screen !== 'undefined' && Math.min(screen.width, screen.height) < 820;
  return coarse && small ? 1024 : 2048;
}

export class WorldPainter {
  /** @param {THREE.WebGLRenderer} renderer */
  constructor(renderer) {
    this.renderer = renderer;
    this.width = mapWidth(renderer);
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    this.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    /** Every map this painter made, for dispose(). */
    this.targets = [];
    this.materials = new Map();
  }

  /**
   * Compiles the shaders these looks need, all at once, before any is painted.
   * Where the browser can (KHR_parallel_shader_compile), that happens off the
   * page's thread, so the loading screen keeps moving; painting with a shader
   * not yet compiled stops the page until it is.
   */
  async prepare({ planets = [], stars = [] }) {
    const materials = new Set([
      ...planets.flatMap((look) => [false, true].map((data) => this._material(PLANET, planetDefines(look, data), planetUniforms(look)))),
      ...stars.map((look) => this._material(STAR, {}, starUniforms(look))),
    ]);
    const scene = new THREE.Scene();
    for (const material of materials) {
      const quad = new THREE.Mesh(this.quad.geometry, material);
      quad.frustumCulled = false;
      scene.add(quad);
    }
    // With a render target bound, as when they draw: three keys each program
    // on where it draws to, and would otherwise compile one for the screen.
    const renderer = this.renderer;
    const target = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    const ready = renderer.compileAsync(scene, this.camera);
    renderer.setRenderTarget(previous);
    await ready;
    target.dispose();
  }

  /** Albedo and data maps for a planet. */
  async paintPlanet(look) {
    const uniforms = planetUniforms(look);
    const map = this._target(THREE.SRGBColorSpace);
    const data = this._target(THREE.NoColorSpace);
    await this._paint(this._material(PLANET, planetDefines(look, false), uniforms), uniforms, map);
    await this._paint(this._material(PLANET, planetDefines(look, true), uniforms), uniforms, data);
    return { map: map.texture, data: data.texture };
  }

  /** Granulation, spots and faculae for a star. */
  async paintStar(look) {
    const target = this._target(THREE.NoColorSpace);
    const uniforms = starUniforms(look);
    await this._paint(this._material(STAR, {}, uniforms), uniforms, target);
    return { data: target.texture };
  }

  /** One material per kind of world, shared by every world of that kind. */
  _material(body, defines, uniforms) {
    const key = `${body === STAR ? 'star' : 'planet'}:${Object.keys(defines).sort().join(',')}`;
    let material = this.materials.get(key);
    if (!material) {
      material = new THREE.ShaderMaterial({
        vertexShader, fragmentShader: NOISE + body, defines, uniforms: { ...uniforms, uZero: { value: 0 } },
        glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false, toneMapped: false,
      });
      this.materials.set(key, material);
    }
    return material;
  }

  /** One map, mipmapped, wrapping east to west. */
  _target(colorSpace) {
    const target = new THREE.WebGLRenderTarget(this.width, this.width / 2, {
      colorSpace,
      depthBuffer: false,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      anisotropy: this.anisotropy,
    });
    this.targets.push(target);
    return target;
  }

  /**
   * Draws one map in horizontal strips, yielding between them, so a slow GPU
   * is never handed one enormous draw (which some drivers kill) and the
   * loading screen keeps moving.
   */
  async _paint(material, uniforms, target) {
    // three binds the uniforms object once, when it compiles; swap values, not objects.
    for (const [name, uniform] of Object.entries(uniforms)) material.uniforms[name].value = uniform.value;
    this.quad.material = material;

    const renderer = this.renderer;
    const previous = renderer.getRenderTarget();
    const xr = renderer.xr.enabled;
    const strips = Math.max(1, this.width / 512);
    const height = target.height / strips;
    for (let i = 0; i < strips; i++) {
      target.scissor.set(0, i * height, target.width, height);
      target.scissorTest = true;
      renderer.xr.enabled = false;
      renderer.setRenderTarget(target);
      renderer.render(this.scene, this.camera);
      renderer.setRenderTarget(previous);
      renderer.xr.enabled = xr;
      await pause();
    }
    target.scissorTest = false;
  }

  dispose() {
    for (const target of this.targets) target.dispose();
    for (const material of this.materials.values()) material.dispose();
    this.quad.geometry.dispose();
    this.targets.length = 0;
  }
}

function planetDefines(look, data) {
  const defines = { [look.type === 'gas' || look.type === 'haze' || look.type === 'cloudy' ? 'GAS' : 'ROCK']: '' };
  if (data) defines.DATA = '';
  if (look.type === 'temperate') defines.TEMPERATE = '';
  if (look.type === 'eyeball') defines.EYEBALL = '';
  if (look.type === 'ice') defines.ICE = '';
  if (look.type === 'lava') defines.LAVA = '';
  return defines;
}

function starUniforms(look) {
  const seed = look.seed ?? 0.5;
  return {
    uOffset: { value: new THREE.Vector3(seed * 97, seed * 57 + 11, seed * 31 + 23) },
    uStar: { value: new THREE.Vector4(look.granules, look.spots, look.polarSpots ? 1 : 0, 0) },
  };
}

function planetUniforms(look) {
  const colour = (hex) => new THREE.Color(hex);
  const seed = look.seed ?? 0.5;
  const bands = look.bands ?? {};
  const terrain = look.terrain ?? {};
  const palette = look.palette.map(colour);
  const ocean = (look.ocean ?? ['#0b2140', '#1a4a6e']).map(colour);
  // Storms at a few latitudes, clear of the equator and the poles.
  const storms = Array.from({ length: 4 }, (_, i) => {
    const r = (salt) => fraction(seed * 7919 + i * 104.729 + salt);
    const lat = (r(1) < 0.5 ? -1 : 1) * (0.25 + 0.5 * r(2));
    const lon = r(3) * Math.PI * 2;
    const c = Math.cos(lat);
    return new THREE.Vector4(-Math.cos(lon) * c, Math.sin(lat), Math.sin(lon) * c, 0.07 + 0.09 * r(4) * (i === 0 ? 1.4 : 0.8));
  });
  return {
    uOffset: { value: new THREE.Vector3(seed * 83.1, seed * 47.3 + 5, seed * 29.9 + 13) },
    uPalette: { value: palette },
    uOcean: { value: ocean },
    uBands: { value: new THREE.Vector4(bands.frequency ?? 10, bands.contrast ?? 0.6, bands.turbulence ?? 0.8, bands.stretch ?? 5) },
    uBands2: { value: new THREE.Vector4(bands.chevron ?? 0, bands.westClouds ?? 0, bands.storms ?? 0, bands.dark ? 1 : 0) },
    uStorms: { value: storms },
    uTerrain: { value: new THREE.Vector4(terrain.craters ?? 0, terrain.roughness ?? 0.5, terrain.sea ?? 0, terrain.ice ?? 2) },
    uTerrain2: { value: new THREE.Vector4(terrain.lavaSea ?? 0, terrain.cracks ?? 0, look.clouds?.coverage ?? 0, look.heat?.shift ?? 0) },
    uHeat: { value: new THREE.Vector4(look.heat ? 1 : 0, look.heat?.uniform ? 1 : 0, 0, 0) },
  };
}

/**
 * A ring system's radial profile, as the 1-pixel-tall strip the ring material
 * and the analytic ring shadows read (like saturn_rings): ringlets from 1D
 * noise, a few clear gaps, soft inner and outer edges.
 */
export function paintRings(rings, seed = 0.5) {
  const width = 512;
  const pixels = new Uint8Array(width * 4);
  const [dark, mid, light] = rings.palette.map((hex) => new THREE.Color(hex));
  const value = (x, salt) => {
    const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
    return fraction(i * 12.9898 + salt) * (1 - u) + fraction((i + 1) * 12.9898 + salt) * u;
  };
  const gaps = Array.from({ length: 1 + Math.floor(fraction(seed * 331) * 3) }, (_, i) => ({
    at: 0.25 + 0.6 * fraction(seed * 173 + i * 7.1), width: 0.012 + 0.03 * fraction(seed * 59 + i * 3.3),
  }));
  const c = new THREE.Color();
  for (let x = 0; x < width; x++) {
    const r = x / (width - 1);
    let density = 0.35 + 0.35 * value(r * 9, seed * 11) + 0.2 * value(r * 37, seed * 23) + 0.1 * value(r * 120, seed * 5);
    density *= smoothstep(0, 0.06, r) * (1 - smoothstep(0.9, 1, r));
    for (const gap of gaps) density *= 0.08 + 0.92 * smoothstep(gap.width * 0.5, gap.width, Math.abs(r - gap.at));
    density = Math.min(1, Math.max(0, density)) ** 1.2;
    c.copy(dark).lerp(mid, Math.min(1, density * 1.4)).lerp(light, value(r * 21, seed * 41) * density);
    c.convertLinearToSRGB();
    pixels.set([c.r * 255, c.g * 255, c.b * 255, density * 255].map(Math.round), x * 4);
  }
  const texture = new THREE.DataTexture(pixels, width, 1, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

function fraction(x) {
  const s = Math.sin(x) * 43758.5453;
  return s - Math.floor(s);
}
function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
function pause() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
