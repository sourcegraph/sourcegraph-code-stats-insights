import * as sourcegraph from 'sourcegraph'
import { from, defer } from 'rxjs'
import { switchMap, map, retry } from 'rxjs/operators'
import { IQuery, IGraphQLResponseRoot } from './schema'
import gql from 'tagged-template-noop'

const languageColors: Record<string, string | undefined> = {
    Go: '#00ACD7',
    TypeScript: '#007acc',
    JavaScript: 'rgb(247, 223, 30)',
    HTML: 'rgb(228, 77, 38)',
    Markdown: '#4d4d4d',
}

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

export function activate(context: sourcegraph.ExtensionContext): void {
    const provideView = () => {
        return from(sourcegraph.configuration).pipe(
            map(() => sourcegraph.configuration.get().value),
            switchMap(configuration => {
                if (!configuration['codeStatsInsights.query']) {
                    return []
                }
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
                        { query: configuration['codeStatsInsights.query'] }
                    )
                ).pipe(
                    retry(3),
                    map(data => data.search!.stats),
                    map(
                        (stats): sourcegraph.View => {
                            const totalLines = Math.max(...stats.languages.map(language => language.totalLines))
                            return {
                                title: configuration['codeStatsInsights.title'],
                                content: [
                                    {
                                        chart: 'pie',
                                        pies: [
                                            {
                                                data: stats.languages
                                                    .filter(language => language.totalLines / totalLines >= 0.05)
                                                    .map(language => ({
                                                        ...language,
                                                        fill: languageColors[language.name],
                                                    })),
                                                dataKey: 'totalLines',
                                                nameKey: 'name',
                                                fillKey: 'fill',
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
        sourcegraph.app.registerViewProvider('codeStatsInsights.languages', {
            where: 'insightsPage',
            provideView,
        })
    )
}

// Sourcegraph extension documentation: https://docs.sourcegraph.com/extensions/authoring
