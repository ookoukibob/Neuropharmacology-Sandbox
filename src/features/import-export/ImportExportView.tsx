/**
 * Import/Export feature root: library context line + Import/Export/
 * Recovery tabs. The record count is shown so preview-before-write is
 * directly visible (it must not change until an import is confirmed).
 *
 * The Recovery tab is separate on purpose (ADR-18): `.npsl`/`.json`/CSV
 * are interchange formats that exclude quarantined rows, while `.npsb`
 * archives and restores raw storage verbatim.
 */
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useLibraryStore } from '@/app/libraryStore'
import { ExportPanel } from './ExportPanel'
import { ImportPanel } from './ImportPanel'
import { RecoveryPanel } from './RecoveryPanel'

export function ImportExportView() {
  const drugs = useLibraryStore((s) => s.drugs)
  const metadata = useLibraryStore((s) => s.metadata)

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground" data-testid="library-record-count">
        Current library: {drugs.length} record{drugs.length === 1 ? '' : 's'}
        {metadata !== undefined ? ` · ${metadata.name}` : ''}
      </p>
      <Tabs defaultValue="import">
        <TabsList>
          <TabsTrigger value="import" data-testid="tab-import">
            Import
          </TabsTrigger>
          <TabsTrigger value="export" data-testid="tab-export">
            Export
          </TabsTrigger>
          <TabsTrigger value="recovery" data-testid="tab-recovery">
            Recovery
          </TabsTrigger>
        </TabsList>
        <TabsContent value="import">
          <ImportPanel />
        </TabsContent>
        <TabsContent value="export">
          <ExportPanel />
        </TabsContent>
        <TabsContent value="recovery">
          <RecoveryPanel />
        </TabsContent>
      </Tabs>
    </div>
  )
}
