import { exampleConfig, optionalArtifactQuery } from './config.mjs';

const { client } = exampleConfig();
const query = optionalArtifactQuery();
const listing = await client.listArtifacts({ query });

console.log(JSON.stringify(listing, null, 2));
