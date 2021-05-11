import * as sourcegraph from 'sourcegraph'
import { from, defer, Subscription } from 'rxjs'
import { map, retry, startWith, distinctUntilChanged, mergeAll, tap } from 'rxjs/operators'
import gql from 'tagged-template-noop'
import { escapeRegExp, partition, sum } from 'lodash'
import isEqual from 'lodash/isEqual'
import linguistLanguages from 'linguist-languages'
import { isLinguistLanguage, parseUri, queryGraphQL } from './utils';

/**
 * Code stat insight settings from user/org setting cascade.
 * */
interface Insight {
    title: string
    repository?: string;
    otherThreshold?: number

    /**
     *  Synthetic field for backward compatibility.
     *  In the first version of code stats insight this query was supposed to be filled
     *  by users in user/org settings. Now we don't need to set this field anymore because
     *  we can derive the query from the repository field. But for the sake of compatibility
     *  with existing first-version insights we left this setting.
     * */
    query?: string;
}

/**
 * Code stats insight extension.
 * Sourcegraph extension documentation: https://docs.sourcegraph.com/extensions/authoring
 *
 * This extension supports two public API in user/org  setting cascade
 *
 * 1. Old API (only one code stats insight can live for entire setting cascade)
 *
 * "codeStatsInsights.query": "repo:^github\\.com/sourcegraph/sourcegraph$",
 * "codeStatsInsights.otherThreshold": 0.01,
 *
 * 2. New API (any number of stats insight can be create in user/org setting cascade)
 *
 * "codeStatsInsights.insight.sourcegraphLanguageUsage": {
 *      "title": "Sourcegraph Language Usage",
 *      "repository": "github.com/sourcegraph/sourcegraph",
 *      "otherThreshold": "0.03"
 * }
 * */
export function activate(context: sourcegraph.ExtensionContext): void {
    const settings = from(sourcegraph.configuration).pipe(
        startWith(null),
        map(() => sourcegraph.configuration.get().value)
    )

    // Observe stats insights settings from user/org setting cascade
    const insightChanges = settings.pipe(
        map(settings => {
                const insightsFromCreationFlow = Array.from(Object.entries(settings))
                    .filter(([key]) =>
                        key.startsWith('codeStatsInsights.insight.')) as [string, Insight | null | false][];

                // In a first version of this extension we had different approach hot to set settings
                // for the sake of backward compatibility we support this old API as well here
                const insightFromOldAPI: [string, Insight | null] = [
                    'codeStatsInsights.insight.language',
                    settings['codeStatsInsights.query']
                        ? {
                            title: 'Language usage',
                            query: settings['codeStatsInsights.query'],
                            otherThreshold: settings['codeStatsInsights.otherThreshold']
                          } as Insight
                        : null
                ]


                return [insightFromOldAPI, ...insightsFromCreationFlow,]
            }
        ),
        distinctUntilChanged((a, b) => isEqual(a, b))
    )

    // Further in main context.subscriptions we have nested calls of context.subscriptions
    // as well, because of this we have to manage inner subscription ourselves. This
    // subscription bag needed to unsubscribe nested calls in a moment when user/org settings
    // have been updated.
    let previousSubscriptions = new Subscription();

    context.subscriptions.add(
        insightChanges.pipe(
            tap(() => {
                previousSubscriptions.unsubscribe()
                previousSubscriptions = new Subscription();
            }),
            mergeAll(),
        ).subscribe(([id, insight]) => {
            if (!insight) {
                return
            }

            const { repository, query: querySetting } = insight;

            const provideView = ({ viewer }: { viewer?: sourcegraph.DirectoryViewer }): Promise<sourcegraph.View> => {

                const query = viewer
                    // Show current repo stats instead of repo which has been specified
                    // in code stats settings.
                    ? `repo:^${escapeRegExp(parseUri(viewer.directory.uri).repo)}$`
                    : querySetting
                        // Show query from old version of code stats insight with full query string
                        ? querySetting
                        // Calculate query string base on repository string from insight settings
                        // this is new approach if user setup insight by creation UI.
                        : `repo:^${escapeRegExp(repository)}`


                return getInsightContent(query, insight);
            }

            const insightPageProvider = sourcegraph.app.registerViewProvider(`${id}.insightsPage`, {
                where: 'insightsPage',
                provideView,
            })

            const directoryPageProvider = sourcegraph.app.registerViewProvider(`${id}.directory`, {
                where: 'directory',
                provideView,
            })

            // Pass next provider to extension API.
            context.subscriptions.add(insightPageProvider)
            context.subscriptions.add(directoryPageProvider)

            // Pass next providers to enclosure subscription bag in case if we got update
            // from the user/org settings in order for us to be able to close provider observables.
            previousSubscriptions.add(insightPageProvider)
            previousSubscriptions.add(directoryPageProvider)
        })
    )
}

async function getInsightContent(query: string, insight: Insight): Promise<sourcegraph.View> {
    // Fetch raw stats for code insight.
    const stats = await defer(() =>
        queryGraphQL(
            gql`
             query SearchResultsStats($query: String!) {
                    search(query: $query) {
                        results {
                            limitHit
                        }
                        stats {
                            languages {
                                name
                                totalLines
                            }
                        }
                    }
                }
            `,
            { query }
        )
    )
        .pipe(
            // The search may timeout, but a retry is then likely faster because caches are warm
            retry(3),
            map(data => data.search!.stats),
        )
        .toPromise()

    const totalLines = sum(stats.languages.map(language => language.totalLines))
    const linkURL = new URL('/stats', sourcegraph.internal.sourcegraphURL)

    linkURL.searchParams.set('q', query)

    const otherThreshold = insight.otherThreshold ?? 0.03
    const [notOther, other] = partition(
        stats.languages,
        language => language.totalLines / totalLines >= otherThreshold
    )
    return {
        title: insight.title,
        content: [
            {
                chart: 'pie',
                pies: [
                    {
                        data: [
                            ...notOther,
                            {
                                name: 'Other',
                                totalLines: sum(other.map(language => language.totalLines)),
                            },
                        ].map(language => ({
                            ...language,
                            fill:
                                (isLinguistLanguage(language.name) &&
                                    linguistLanguages[language.name].color) ||
                                'gray',
                            linkURL: linkURL.href,
                        })),
                        dataKey: 'totalLines',
                        nameKey: 'name',
                        fillKey: 'fill',
                        linkURLKey: 'linkURL',
                    },
                ],
            },
        ],
    }
}
