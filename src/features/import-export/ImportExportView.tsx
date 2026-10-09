/**
 * Import/Export feature root: library context line + Import/Export tabs.
 * The record count is shown so preview-before-write is directly visible
 * (it must not change until an import is confirmed).
 */
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useLibraryStore } from '@/app/libraryStore'
import { ExportPanel } from './ExportPanel'
import { ImportPanel } from './ImportPanel'

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
        </TabsList>
        <TabsContent value="import">
          <ImportPanel />
        </TabsContent>
        <TabsContent value="export">
          <ExportPanel />
        </TabsContent>
      </Tabs>
    </div>
  )
}
