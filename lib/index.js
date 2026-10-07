import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export const name = 'hw-topo-dsh';
export const PACKAGE_NAME = 'hw-topo-dsh';

export function resolveHwTopoSkillRoot(profileBaseUrl) {
  if (!profileBaseUrl) {
    throw new Error('hw-topo-dsh: missing DSH profile baseUrl for package resolution');
  }
  let manifestPath;
  try {
    manifestPath = createRequire(profileBaseUrl).resolve(`${PACKAGE_NAME}/package.json`);
  } catch (error) {
    throw new Error(
      `hw-topo-dsh: cannot resolve ${PACKAGE_NAME}/package.json from the DSH profile`,
      { cause: error },
    );
  }
  return join(dirname(manifestPath), 'skills');
}
