import * as sourcegraph from 'sourcegraph'
import { from, defer } from 'rxjs'
import { switchMap, map, retry } from 'rxjs/operators'
import { IQuery, IGraphQLResponseRoot } from './schema'
import gql from 'tagged-template-noop'
import { escapeRegExp, partition, sum } from 'lodash'
import linguistLanguages from 'linguist-languages'

const isLinguistLanguage = (language: string): language is keyof typeof linguistLanguages =>
    Object.prototype.hasOwnProperty.call(linguistLanguages, language)

const queryGraphQL = async <T = IQuery>(query: string, variables: object = {}): Promise<T> => {
    const { data, errors }: IGraphQLResponseRoot = await sourcegraph.commands.executeCommand(
        'queryGraphQL',
        query,
        variables
    )
    if (errors && errors.length > 0) {
        throw new Error(errors.map(e => e.message).join('\n'))
    }
    return (data as any) as T
}

const parseUri = (uri: URL): { repo: string } => {
    return { repo: uri.hostname + uri.pathname }
}

export function activate(context: sourcegraph.ExtensionContext): void {
    const provideView = ({ viewer }: { viewer?: sourcegraph.DirectoryViewer }) => {
        return from(sourcegraph.configuration).pipe(
            map(() => sourcegraph.configuration.get().value),
            switchMap(configuration => {
                if (!configuration['codeStatsInsights.query']) {
                    return []
                }
                const query = viewer
                    ? `repo:^${escapeRegExp(parseUri(viewer.directory.uri).repo)}$`
                    : configuration['codeStatsInsights.query']
                return defer(() =>
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
                ).pipe(
                    retry(3),
                    map(data => data.search!.stats),
                    map(
                        (stats): sourcegraph.View => {
                            const totalLines = sum(stats.languages.map(language => language.totalLines))
                            const linkURL = new URL('/stats', sourcegraph.internal.sourcegraphURL)
                            linkURL.searchParams.set('q', query)
                            const otherThreshold = configuration['codeStatsInsights.otherThreshold'] ?? 0.03
                            const [notOther, other] = partition(
                                stats.languages,
                                language => language.totalLines / totalLines >= otherThreshold
                            )
                            return {
                                title: configuration['codeStatsInsights.title'] ?? 'Language usage',
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
                                                    fill: isLinguistLanguage(language.name)
                                                        ? linguistLanguages[language.name].color
                                                        : 'gray',
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
                    )
                )
            })
        )
    }
    context.subscriptions.add(
        sourcegraph.app.registerViewProvider('codeStatsInsights.languages.insightsPage', {
            where: 'insightsPage',
            provideView,
        })
    )
    context.subscriptions.add(
        sourcegraph.app.registerViewProvider('codeStatsInsights.languages.directory', {
            where: 'directory',
            provideView,
        })
    )
}

// Sourcegraph extension documentation: https://docs.sourcegraph.com/extensions/authoring
