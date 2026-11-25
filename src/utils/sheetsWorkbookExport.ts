import { SHEET_TABS, type SheetSyncPayload } from '../../shared/googleSheetsSchema';
import { buildSheetSyncPayload, type ShopSnapshotData } from '../services/googleSheetsMapper';
import { getKarachiDateIso } from './formatters';

function formatKarachiFilenameDate(): string {
  const iso = getKarachiDateIso(); // YYYY-MM-DD
  const [y, m, d] = iso.split('-');
  return d && m && y ? `${d}-${m}-${y}` : iso;
}

export async function exportAllTabsWorkbook(data: ShopSnapshotData): Promise<{
  filename: string;
  totalRows: number;
  tabCount: number;
}> {
  const XLSX = await import('xlsx');
  const allTabNames = SHEET_TABS.map((t) => t.name);
  const payload: SheetSyncPayload = buildSheetSyncPayload(data, allTabNames);
  const workbook = XLSX.utils.book_new();

  let totalRows = 0;

  for (const tab of SHEET_TABS) {
    const rows = payload[tab.name] || [];
    totalRows += rows.length;

    const sheetData = [[...tab.headers], ...rows];
    const worksheet = XLSX.utils.aoa_to_sheet(sheetData);
    worksheet['!cols'] = tab.columnWidths.map((px) => ({
      wch: Math.max(10, Math.round(px / 7)),
    }));

    // Excel tab titles allow max 31 characters and exclude : \ / ? * [ ]
    const safeTitle = tab.name.replace(/[:\\/?*[\]]/g, '').slice(0, 31);
    XLSX.utils.book_append_sheet(workbook, worksheet, safeTitle);
  }

  const filename = `CareMart_Business_Records_${formatKarachiFilenameDate()}.xlsx`;
  XLSX.writeFile(workbook, filename);

  return {
    filename,
    totalRows,
    tabCount: SHEET_TABS.length,
  };
}
