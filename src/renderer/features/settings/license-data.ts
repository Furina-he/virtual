import assetCc0Text from '../../../../content/ASSET-CC0-1.0.txt?raw'
import assetFontOflText from '../../../../content/ASSET-FONT-OFL.txt?raw'
import assetLicensesCsv from '../../../../content/ASSET-LICENSES.csv?raw'
import assetNoticesText from '../../../../content/ASSET-NOTICES.md?raw'
import pkg from '../../../../package.json'
import ngspiceCopyingText from '../../../../resources/ngspice/COPYING?raw'
import ngspiceLicenseNotesText from '../../../../resources/ngspice/LICENSE-NOTES.md?raw'
import ngspiceThirdPartyText from '../../../../resources/ngspice/THIRD-PARTY-LICENSES.txt?raw'
import {
  BUNDLED_FONT_LICENSES,
  BUNDLED_SPICE_LIBRARY_FILES,
  parseAssetLicensesCsv,
  parseNgspiceLicenseNotes,
  summarizeAssetLicenses,
} from '../../../domain/licenses/catalog'

const assetRows = parseAssetLicensesCsv(assetLicensesCsv)
const assetSummary = summarizeAssetLicenses(assetRows)
const ngspiceSummary = parseNgspiceLicenseNotes(ngspiceLicenseNotesText)

export const appLicenseBundle = {
  appName: pkg.productName,
  packageName: pkg.name,
  version: pkg.version,
  assetRows,
  assetSummary,
  ngspiceSummary,
  fonts: BUNDLED_FONT_LICENSES,
  spiceLibraries: BUNDLED_SPICE_LIBRARY_FILES,
  texts: [
    {
      id: 'ngspice-copying',
      label: 'ngspice COPYING（BSD / XSPICE / LGPL 2.1）',
      file: 'resources/ngspice/COPYING',
      content: ngspiceCopyingText,
    },
    {
      id: 'ngspice-third-party',
      label: 'libsamplerate（BSD-2）与 LLVM OpenMP（Apache-2.0）',
      file: 'resources/ngspice/THIRD-PARTY-LICENSES.txt',
      content: ngspiceThirdPartyText,
    },
    {
      id: 'font-ofl',
      label: 'SIL OFL 1.1（本地字体）',
      file: 'content/ASSET-FONT-OFL.txt',
      content: assetFontOflText,
    },
    {
      id: 'asset-cc0',
      label: 'CC0 1.0 Universal（HDRI 与 3D 工具网格）',
      file: 'content/ASSET-CC0-1.0.txt',
      content: assetCc0Text,
    },
    {
      id: 'asset-notices',
      label: '随包资产声明（ASSET-NOTICES）',
      file: 'content/ASSET-NOTICES.md',
      content: assetNoticesText,
    },
  ] as const,
}
