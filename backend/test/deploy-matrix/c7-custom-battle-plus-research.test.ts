/**
 * The deploy matrix, configuration C7-custom+research: C7-custom with one battle-capable member classification
 * added on its own. The checks and the configuration's data are in `matrix.ts` and `configurations.ts`.
 *
 * Beside the checks every configuration runs, its independence check diffs it against C7-custom in both
 * directions, where Battle Mode, experiments, a guest issuer and a host's one-conversation issuer are declared:
 * adding `research` and removing it change nothing outside `Assistants-research`
 * (`describeClassificationIndependence`, `matrix.ts`), with no exception named. A classification's alt and
 * its grants on the battle and experiments tables are its own stack's (`classification-capabilities.ts`), so
 * Battle and Experiments name no classification.
 */
import { describeClassificationIndependence, describeConfiguration } from './matrix';

describeConfiguration('C7-custom+research');

describeClassificationIndependence('C7-custom+research');
