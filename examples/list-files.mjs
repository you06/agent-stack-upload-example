import { exampleConfig, optionalDirectoryPath } from './config.mjs';

const { client } = exampleConfig();
const directoryPath = optionalDirectoryPath();
const listing = await client.listDriveFiles({ directoryPath });

console.log(JSON.stringify(listing, null, 2));
