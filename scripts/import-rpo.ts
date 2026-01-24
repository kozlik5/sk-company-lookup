import 'dotenv/config';
import { ImportService } from '../src/services/ImportService.js';

async function main() {
  console.log('='.repeat(50));
  console.log('Slovak Company Data Import');
  console.log('='.repeat(50));

  const result = await ImportService.runFullImport();

  console.log('\n' + '='.repeat(50));
  console.log('Import Result:');
  console.log('  Success:', result.success);
  console.log('  Records:', result.recordCount);
  console.log('  Duration:', Math.round(result.duration / 1000), 'seconds');
  if (result.error) {
    console.log('  Error:', result.error);
  }
  console.log('='.repeat(50));

  process.exit(result.success ? 0 : 1);
}

main().catch(console.error);
