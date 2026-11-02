/**
 * The deploy matrix, configuration C1-custom+enterprise: C1-custom with one classification added on its own.
 * The checks and the configuration's data are in `matrix.ts` and `configurations.ts`.
 *
 * Beside the checks every configuration runs, its independence check diffs it against C1-custom in both
 * directions: adding `enterprise` and removing it change nothing outside `Assistants-enterprise`
 * (`describeClassificationIndependence`, `matrix.ts`), with no exception named.
 */
import { describeClassificationIndependence, describeConfiguration } from './matrix';

describeConfiguration('C1-custom+enterprise');

describeClassificationIndependence('C1-custom+enterprise');
