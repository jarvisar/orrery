/**
 * electron-builder configuration. Used through scripts/build.js, which stages
 * the web app into web/ and fills in the version from the root package.json.
 *
 * What each platform gets:
 *   Windows  an installer (per user, no admin rights) and a portable .exe
 *   Linux    an AppImage (Steam Deck, and anything else), a .deb, and a .tar.gz
 *   macOS    a .dmg each for Apple silicon and Intel
 *
 * @see https://www.electron.build/configuration
 */
import { APP_ID, PRODUCT_NAME } from './src/identity.js';

/**
 * @param {object} options
 * @param {string} options.version From the root package.json.
 * @param {boolean} options.macSigning A Developer ID certificate is available
 *   (CSC_LINK / CSC_NAME). Without one the Mac app is ad-hoc signed, which is
 *   what lets it open at all on Apple silicon; see desktop/README.md.
 * @returns {import('electron-builder').Configuration}
 */
export default function config({ version, macSigning }) {
  return {
    appId: APP_ID,
    productName: PRODUCT_NAME,
    copyright: `Copyright © ${new Date().getFullYear()} Adam Jarvis`,
    extraMetadata: { version },

    directories: { output: 'dist', buildResources: 'build' },
    files: [
      'package.json',
      'src/**',
      'build/icon.png', // the Linux window icon, at runtime
      'web/**',
    ],
    asar: true,
    // The interface is English, so the other 50-odd Chromium locales are dead weight.
    electronLanguages: ['en-US'],

    artifactName: '${productName}-${version}-${os}-${arch}.${ext}',

    // Where auto-updates come from (src/updates.js). electron-builder bakes
    // this into the app as app-update.yml and writes the latest*.yml files
    // the updater reads; the release workflow uploads those alongside the
    // installers. Builds never publish by themselves (publish: 'never').
    publish: [{ provider: 'github', owner: 'jarvisar', repo: 'orrery', releaseType: 'release' }],

    win: {
      icon: 'build/icon.png',
      target: [
        { target: 'nsis', arch: ['x64'] },
        { target: 'portable', arch: ['x64'] },
      ],
    },
    nsis: {
      artifactName: '${productName}-${version}-win-${arch}-setup.${ext}',
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      shortcutName: PRODUCT_NAME,
    },
    portable: {
      artifactName: '${productName}-${version}-win-${arch}-portable.${ext}',
    },

    linux: {
      icon: 'build/icon.png',
      executableName: 'orrery',
      syncDesktopName: true,
      category: 'Education',
      synopsis: 'An interactive 3D solar system',
      target: [
        { target: 'AppImage', arch: ['x64'] },
        { target: 'deb', arch: ['x64'] },
        { target: 'tar.gz', arch: ['x64'] },
      ],
      desktop: {
        entry: {
          Name: PRODUCT_NAME,
          GenericName: 'Solar System Model',
          Comment: 'An interactive 3D model of the solar system',
          Keywords: 'space;astronomy;planets;solar system;orrery;',
          Categories: 'Education;Science;Astronomy;',
        },
      },
    },
    deb: {
      packageCategory: 'science',
    },

    mac: {
      icon: 'build/icon-mac.png',
      category: 'public.app-category.education',
      darkModeSupport: true,
      target: [{ target: 'dmg', arch: ['arm64', 'x64'] }],
      // Signed and notarized when the certificate and Apple ID secrets are
      // there; ad-hoc signed ('-') otherwise.
      identity: macSigning ? undefined : '-',
      hardenedRuntime: macSigning,
      notarize: macSigning ? undefined : false,
    },
    dmg: {
      artifactName: '${productName}-${version}-mac-${arch}.${ext}',
    },
  };
}
